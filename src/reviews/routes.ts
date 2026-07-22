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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionRunnerLike } from '../sessions/routes.js';
import type { SessionMeta, SessionStore } from '../sessions/store.js';
import type { GhRunner } from './gh.js';
import { attachLastReview, listOpenPrs } from './prs.js';
import { buildReviewPrompt } from './prompt.js';

export interface ReviewRoutesConfig {
  store: SessionStore;
  runner: SessionRunnerLike;
  token: string;
  /** GitHub org whose open PRs the surface lists (e.g. `market-clue`). */
  org: string;
  /** Org checkouts live at `{checkoutRoot}/{repo}` — nowhere else. */
  checkoutRoot: string;
  /** MC-R2: GitHub user whose personal open PRs are listed too (e.g. `richsmon`). */
  ownUser: string;
  /** MC-R2: personal-repo checkouts live at `{ownRoot}/{repo}`. */
  ownRoot: string;
  gh: GhRunner;
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

export function registerReviewRoutes(app: FastifyInstance, config: ReviewRoutesConfig): void {
  const { store, runner, token, org, checkoutRoot, ownUser, ownRoot, gh } = config;
  // Map, not a plain object — `owner` comes from the request body and a plain
  // object lookup would resolve prototype keys like `constructor`.
  const rootByOwner = new Map<string, string>([
    [org, checkoutRoot],
    [ownUser, ownRoot],
  ]);

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
        // MC-R3: the list remembers — each row links its most recent review session.
        return attachLastReview(prs, store.listSessions());
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
