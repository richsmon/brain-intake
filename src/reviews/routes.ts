// MC-R1: Fastify routes for the MC review surface. Same bearer guard as the
// sessions module (one shared token — the reviews surface is an extension of
// the coding surface). Launching a review reuses the sessions store + runner:
// the response's sessionId opens the existing session detail in the app.
//
// Local-checkout rule: POST /reviews only launches into a checkout that already
// exists under `checkoutRoot` — a repo without one gets a 409 with the expected
// path. This slice never clones anything.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionRunnerLike } from '../sessions/routes.js';
import type { SessionMeta, SessionStore } from '../sessions/store.js';
import type { GhRunner } from './gh.js';
import { listOpenPrs } from './prs.js';
import { buildReviewPrompt } from './prompt.js';

export interface ReviewRoutesConfig {
  store: SessionStore;
  runner: SessionRunnerLike;
  token: string;
  /** GitHub org whose open PRs the surface lists (e.g. `market-clue`). */
  org: string;
  /** Local checkouts live at `{checkoutRoot}/{repo}` — nowhere else. */
  checkoutRoot: string;
  gh: GhRunner;
}

interface PostReviewBody {
  repo?: unknown;
  pr?: unknown;
  model?: unknown;
  effort?: unknown;
}

/** No slashes, no leading dot — the repo name becomes a path segment. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function registerReviewRoutes(app: FastifyInstance, config: ReviewRoutesConfig): void {
  const { store, runner, token, org, checkoutRoot, gh } = config;

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
        return await listOpenPrs(gh, org);
      } catch (err) {
        app.log.error({ err }, 'gh PR listing failed');
        return reply.code(502).send({ error: 'gh unavailable' });
      }
    });

    scoped.post('/reviews', async (req, reply) => {
      const body = (req.body ?? {}) as PostReviewBody;
      const repo = typeof body.repo === 'string' ? body.repo : '';
      if (!REPO_NAME.test(repo)) {
        return reply.code(400).send({ error: `invalid repo: ${repo || '(none)'}` });
      }
      const pr = typeof body.pr === 'number' ? body.pr : NaN;
      if (!Number.isInteger(pr) || pr <= 0) {
        return reply.code(400).send({ error: 'pr must be a positive integer' });
      }

      const repoPath = join(checkoutRoot, repo);
      if (!existsSync(repoPath)) {
        return reply.code(409).send({
          error: `no local checkout for ${org}/${repo} — expected ${repoPath}; clone it on the host first`,
        });
      }

      const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5';
      const effort = typeof body.effort === 'string' ? body.effort : undefined;

      const meta: SessionMeta = {
        repo: `${org}/${repo}`,
        repoPath,
        prompt: buildReviewPrompt({ org, repo, pr }),
        model,
        // Reviews are read-only by design — gated blocks every edit on approval.
        permissionMode: 'gated',
        ...(effort !== undefined ? { effort } : {}),
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
