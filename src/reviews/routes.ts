// MC-R1: Fastify routes for the MC review surface. Same bearer guard as the
// sessions module (one shared token — the reviews surface is an extension of
// the coding surface). Launching a review reuses the sessions store + runner:
// the response's sessionId opens the existing session detail in the app.
//
// Local-checkout rule: POST /reviews only launches into a checkout that already
// exists under the owner's checkout root — a repo without one gets a 409 with
// the expected path. This slice never clones anything.
//
// MC-R3: POST /reviews stamps a `review: {owner, repo, pr}` ref into session
// meta, and GET /reviews/prs joins the session store back onto each PR row as
// `lastReview` — the list remembers which PRs already have a review session.
//
// MC-R2: two owners. The team org's checkouts live under `checkoutRoot`
// (`~/code/market-clue` by default); the founder's personal repos live under
// `ownRoot` (`~/code` by default). POST /reviews accepts `owner` and defaults
// to the org for backward compat with older app builds.
//
// MC-R6: the owner split is load-bearing. `owner === org` ⇒ FULL review flow:
// unique worktree at the PR head (server-created before the session, server-
// removed on the session's terminal state), acceptEdits mode, session-scoped
// bash-allowlist extension pinned to this one review, full-review brief
// (review doc PR in the MC brain + verdict-conditional platform feedback).
// Any other owner ⇒ the MC-R1 read-only quick look, unchanged byte-for-byte.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionRunnerLike } from '../sessions/routes.js';
import type { SessionMeta, SessionStore } from '../sessions/store.js';
import type { GhRunner } from './gh.js';
import { attachLastReview, listOpenPrs } from './prs.js';
import { buildFullReviewPrompt, buildReviewPrompt } from './prompt.js';
import {
  addWorktree,
  fullReviewBashAllowlist,
  removeWorktree,
  resolvePrBranch,
  uniqueWorktreePath,
  type GitRunner,
} from './worktree.js';

export interface ReviewRoutesConfig {
  store: SessionStore;
  runner: SessionRunnerLike;
  token: string;
  /** GitHub org whose open PRs the surface lists (e.g. `market-clue`). */
  org: string;
  /** Org checkouts live at `{checkoutRoot}/{repo}` — nowhere else. The MC
   * brain checkout is `{checkoutRoot}/brain` (MC-R6). */
  checkoutRoot: string;
  /** MC-R2: GitHub user whose personal open PRs are listed too (e.g. `richsmon`). */
  ownUser: string;
  /** MC-R2: personal-repo checkouts live at `{ownRoot}/{repo}`. */
  ownRoot: string;
  gh: GhRunner;
  /** MC-R6: injected git shell-out for the worktree lifecycle. */
  git: GitRunner;
  /** MC-R6: unique review worktrees are created under this dir. Defaults to
   * the OS tmpdir. */
  worktreeBase?: string;
}

interface PostReviewBody {
  owner?: unknown;
  repo?: unknown;
  pr?: unknown;
  model?: unknown;
  effort?: unknown;
}

/** No slashes, no leading dot — the repo name becomes a path segment. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** MC-R6: the store states on which the server reclaims the review worktree. */
const TERMINAL = new Set(['done', 'error', 'paused']);

export function registerReviewRoutes(app: FastifyInstance, config: ReviewRoutesConfig): void {
  const { store, runner, token, org, checkoutRoot, ownUser, ownRoot, gh, git } = config;
  const worktreeBase = config.worktreeBase ?? tmpdir();
  // Map, not a plain object — `owner` comes from the request body and a plain
  // object lookup would resolve prototype keys like `constructor`.
  const rootByOwner = new Map<string, string>([
    [org, checkoutRoot],
    [ownUser, ownRoot],
  ]);

  /** MC-R6: remove the worktree on the session's FIRST terminal transition —
   * server-side via the store's status trail, never trusted to the model. */
  function reapWorktreeOnTerminal(sessionId: string, repoPath: string, wtPath: string): void {
    const unsubscribe = store.subscribe(sessionId, (event) => {
      if (event.event !== 'status' || typeof event.status !== 'string' || !TERMINAL.has(event.status)) return;
      unsubscribe();
      removeWorktree(git, repoPath, wtPath).catch((err: unknown) => {
        app.log.error({ err, sessionId, wtPath }, 'review worktree removal failed');
      });
    });
  }

  void app.register((scoped, _opts, done) => {
    scoped.addHook('onRequest', (req, reply, next) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      next();
    });

    scoped.get('/reviews/prs', async (_req, reply) => {
      try {
        const prs = await listOpenPrs(gh, org, ownUser);
        // MC-R3: the list remembers — each row links its most recent review
        // session. MC-R6: `fullReview` tags org rows so the app can label the
        // flow the row launches (owner split decided server-side, once).
        return attachLastReview(prs, store.listSessions()).map((row) => ({
          ...row,
          fullReview: row.owner === org,
        }));
      } catch (err) {
        app.log.error({ err }, 'gh PR listing failed');
        return reply.code(502).send({ error: 'gh unavailable' });
      }
    });

    scoped.post('/reviews', async (req, reply) => {
      const body = (req.body ?? {}) as PostReviewBody;
      // MC-R2: owner defaults to the org so pre-MC-R2 app builds keep working.
      const owner = typeof body.owner === 'string' && body.owner !== '' ? body.owner : org;
      const root = rootByOwner.get(owner);
      if (root === undefined) {
        return reply.code(400).send({ error: `unknown owner: ${owner}` });
      }
      const repo = typeof body.repo === 'string' ? body.repo : '';
      if (!REPO_NAME.test(repo)) {
        return reply.code(400).send({ error: `invalid repo: ${repo || '(none)'}` });
      }
      const pr = typeof body.pr === 'number' ? body.pr : NaN;
      if (!Number.isInteger(pr) || pr <= 0) {
        return reply.code(400).send({ error: 'pr must be a positive integer' });
      }

      const repoPath = join(root, repo);
      if (!existsSync(repoPath)) {
        return reply.code(409).send({
          error: `no local checkout for ${owner}/${repo} — expected ${repoPath}; clone it on the host first`,
        });
      }

      const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5';
      const effort = typeof body.effort === 'string' ? body.effort : undefined;

      // MC-R6: org PRs get the full flow; everything else stays the MC-R1
      // read-only quick look, unchanged.
      if (owner === org) {
        const mcBrainPath = join(checkoutRoot, 'brain');
        if (!existsSync(mcBrainPath)) {
          return reply.code(409).send({
            error: `no local checkout of the MC brain — expected ${mcBrainPath}; clone it on the host first`,
          });
        }

        let branch: string;
        const wtPath = uniqueWorktreePath(worktreeBase, repo, pr);
        try {
          branch = await resolvePrBranch(gh, `${owner}/${repo}`, pr);
          await addWorktree(git, repoPath, branch, wtPath);
        } catch (err) {
          app.log.error({ err, repo, pr }, 'review worktree setup failed');
          return reply.code(502).send({ error: 'worktree setup failed — is the PR branch reachable?' });
        }

        const meta: SessionMeta = {
          repo: `${owner}/${repo}`,
          // The session lives INSIDE the worktree — its cwd is the PR head.
          repoPath: wtPath,
          prompt: buildFullReviewPrompt({ owner, repo, pr, branch, worktreePath: wtPath, mcBrainPath }),
          model,
          // acceptEdits: the session writes the review doc; Bash still gates
          // outside the default allowlist + this review's scoped extension.
          permissionMode: 'acceptEdits',
          ...(effort !== undefined ? { effort } : {}),
          review: { owner, repo, pr },
        };
        const id = store.createSession(meta);
        reapWorktreeOnTerminal(id, repoPath, wtPath);
        void runner
          .run(id, meta, {
            model,
            permissionMode: 'acceptEdits',
            extraBashAllowlist: fullReviewBashAllowlist({ owner, repo, pr, worktreePath: wtPath, mcBrainPath }),
            ...(effort !== undefined ? { effort } : {}),
          })
          .catch(() => {
            store.appendEvent(id, { event: 'status', status: 'error' });
          });
        return reply.code(201).send({ sessionId: id });
      }

      const meta: SessionMeta = {
        repo: `${owner}/${repo}`,
        repoPath,
        prompt: buildReviewPrompt({ owner, repo, pr }),
        model,
        // Reviews are read-only by design — gated blocks every edit on approval.
        permissionMode: 'gated',
        ...(effort !== undefined ? { effort } : {}),
        // MC-R3: stamp which PR this session reviews so /reviews/prs can link back.
        review: { owner, repo, pr },
      };
      const id = store.createSession(meta);
      void runner
        .run(id, meta, { model, permissionMode: 'gated', ...(effort !== undefined ? { effort } : {}) })
        .catch(() => {
          store.appendEvent(id, { event: 'status', status: 'error' });
        });
      return reply.code(201).send({ sessionId: id });
    });

    done();
  });
}
