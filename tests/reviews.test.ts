import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, test } from 'vitest';
import { SessionStore, type SessionMeta } from '../src/sessions/store.js';
import type { SessionRunnerLike } from '../src/sessions/routes.js';
import { listOpenPrs } from '../src/reviews/prs.js';
import { buildReviewPrompt } from '../src/reviews/prompt.js';
import { registerReviewRoutes } from '../src/reviews/routes.js';
import type { GhRunner } from '../src/reviews/gh.js';

const TOKEN = 'test-bearer-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function graphqlPayload(nodes: unknown[]): string {
  return JSON.stringify({ data: { search: { nodes } } });
}

const PR_NODES = [
  {
    number: 90,
    title: 'Add login flow',
    headRefName: 'login-pages',
    updatedAt: '2026-07-20T10:00:00Z',
    additions: 7390,
    deletions: 2155,
    author: { login: 'ArsenLabovich' },
    repository: { name: 'app' },
  },
  {
    number: 94,
    title: 'Harden dashboard aggregation',
    headRefName: 'MC-74/dashboard-aggregation-hardening',
    updatedAt: '2026-07-21T17:03:51Z',
    additions: 1534,
    deletions: 34,
    author: { login: 'palo-kunovsky' },
    repository: { name: 'platform' },
  },
];

class FakeRunner implements SessionRunnerLike {
  started: Array<{ id: string; meta: SessionMeta; opts: unknown }> = [];
  run(id: string, meta: SessionMeta, opts?: unknown): Promise<void> {
    this.started.push({ id, meta, opts });
    return Promise.resolve();
  }
  approve(): boolean {
    return true;
  }
  deny(): boolean {
    return true;
  }
  setMode(): Promise<boolean> {
    return Promise.resolve(true);
  }
  sendMessage(): boolean {
    return true;
  }
}

function build(gh: GhRunner): {
  app: FastifyInstance;
  store: SessionStore;
  runner: FakeRunner;
  checkoutRoot: string;
} {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'reviews-sessions-')));
  const runner = new FakeRunner();
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'mc-checkouts-'));
  mkdirSync(join(checkoutRoot, 'app'));
  const app = Fastify();
  registerReviewRoutes(app, {
    store,
    runner,
    token: TOKEN,
    org: 'market-clue',
    checkoutRoot,
    gh,
  });
  return { app, store, runner, checkoutRoot };
}

const ghOk: GhRunner = () => Promise.resolve(graphqlPayload(PR_NODES));

describe('listOpenPrs', () => {
  test('one GraphQL search call — flattens nodes, newest activity first', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      return Promise.resolve(graphqlPayload(PR_NODES));
    };
    const prs = await listOpenPrs(gh, 'market-clue');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(calls[0]!.join(' ')).toContain('q=org:market-clue is:pr is:open');

    expect(prs.map((p) => `${p.repo}#${p.number}`)).toEqual(['platform#94', 'app#90']);
    expect(prs[1]).toEqual({
      repo: 'app',
      number: 90,
      title: 'Add login flow',
      author: 'ArsenLabovich',
      branch: 'login-pages',
      updatedAt: '2026-07-20T10:00:00Z',
      additions: 7390,
      deletions: 2155,
    });
  });

  test('drops malformed nodes instead of crashing', async () => {
    const gh: GhRunner = () => Promise.resolve(graphqlPayload([{}, PR_NODES[0]]));
    const prs = await listOpenPrs(gh, 'market-clue');
    expect(prs).toHaveLength(1);
    expect(prs[0]!.number).toBe(90);
  });
});

describe('bearer-token guard', () => {
  test('both review routes reject a missing/wrong token with 401', async () => {
    const { app } = build(ghOk);
    expect((await app.inject({ method: 'GET', url: '/reviews/prs' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/reviews/prs', headers: { authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/reviews', payload: { repo: 'app', pr: 90 } })).statusCode,
    ).toBe(401);
  });
});

describe('GET /reviews/prs', () => {
  test('lists open PRs across the org', async () => {
    const { app } = build(ghOk);
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const prs = res.json();
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({ repo: 'platform', number: 94, author: 'palo-kunovsky' });
  });

  test('gh failure ⇒ 502, mirroring the approvals routes', async () => {
    const { app } = build(() => Promise.reject(new Error('gh exploded')));
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'gh unavailable' });
  });
});

describe('POST /reviews', () => {
  test('launches a gated review session in the local checkout and returns {sessionId}', async () => {
    const { app, store, runner, checkoutRoot } = build(ghOk);
    const res = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { repo: 'app', pr: 90, model: 'claude-opus-4-8', effort: 'high' },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json();
    expect(store.has(sessionId)).toBe(true);

    expect(runner.started).toHaveLength(1);
    const { meta, opts } = runner.started[0]!;
    expect(meta.repo).toBe('market-clue/app');
    expect(meta.repoPath).toBe(join(checkoutRoot, 'app'));
    expect(meta.permissionMode).toBe('gated');
    expect(opts).toEqual({ model: 'claude-opus-4-8', permissionMode: 'gated', effort: 'high' });

    // The session shows up in the store exactly like a coding session would.
    expect(store.readEvents(sessionId)[0]).toMatchObject({
      event: 'status',
      status: 'created',
      repo: 'market-clue/app',
      model: 'claude-opus-4-8',
    });
  });

  test('the brief fetches the diff read-only and forbids any GitHub write', async () => {
    const { app, runner } = build(ghOk);
    await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    const prompt = runner.started[0]!.meta.prompt;
    expect(prompt).toContain('gh pr view 90 --repo market-clue/app');
    expect(prompt).toContain('gh pr diff 90 --repo market-clue/app');
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('never post comments');
    expect(prompt).toContain('never push');
  });

  test('repo without a local checkout ⇒ 409 with the expected path — never clones', async () => {
    const { app, runner, checkoutRoot } = build(ghOk);
    const res = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { repo: 'platform', pr: 94 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('no local checkout for market-clue/platform');
    expect(res.json().error).toContain(join(checkoutRoot, 'platform'));
    expect(runner.started).toHaveLength(0);
  });

  test('invalid repo name or pr ⇒ 400 (path-traversal names included)', async () => {
    const { app } = build(ghOk);
    const bad = async (payload: Record<string, unknown>) =>
      (await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload })).statusCode;
    expect(await bad({ pr: 90 })).toBe(400);
    expect(await bad({ repo: '../escape', pr: 90 })).toBe(400);
    expect(await bad({ repo: 'a/b', pr: 90 })).toBe(400);
    expect(await bad({ repo: 'app' })).toBe(400);
    expect(await bad({ repo: 'app', pr: 0 })).toBe(400);
    expect(await bad({ repo: 'app', pr: '90' })).toBe(400);
  });

  test('model defaults like the sessions route when omitted', async () => {
    const { app, runner } = build(ghOk);
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    expect(res.statusCode).toBe(201);
    expect(runner.started[0]!.opts).toEqual({ model: 'claude-sonnet-5', permissionMode: 'gated' });
  });
});

describe('buildReviewPrompt', () => {
  test('carries org/repo/pr into every gh command it prescribes', () => {
    const prompt = buildReviewPrompt({ org: 'market-clue', repo: 'platform', pr: 94 });
    expect(prompt).toContain('pull request #94 in market-clue/platform');
    expect(prompt).toContain('gh pr diff 94 --repo market-clue/platform');
    expect(prompt).toContain('Do not create, edit or delete any files.');
  });
});
