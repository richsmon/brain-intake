import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    repository: { name: 'app', owner: { login: 'market-clue' } },
  },
  {
    number: 94,
    title: 'Harden dashboard aggregation',
    headRefName: 'MC-74/dashboard-aggregation-hardening',
    updatedAt: '2026-07-21T17:03:51Z',
    additions: 1534,
    deletions: 34,
    author: { login: 'palo-kunovsky' },
    repository: { name: 'platform', owner: { login: 'market-clue' } },
  },
  // MC-R2: the founder's personal repos ride the same list.
  {
    number: 13,
    title: 'Voice input for the New Session prompt',
    headRefName: 'feat/voice-prompt',
    updatedAt: '2026-07-22T01:45:06Z',
    additions: 320,
    deletions: 12,
    author: { login: 'richsmon' },
    repository: { name: 'brain-intake', owner: { login: 'richsmon' } },
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
  ownRoot: string;
} {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'reviews-sessions-')));
  const runner = new FakeRunner();
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'mc-checkouts-'));
  mkdirSync(join(checkoutRoot, 'app'));
  const ownRoot = mkdtempSync(join(tmpdir(), 'own-checkouts-'));
  mkdirSync(join(ownRoot, 'brain-intake'));
  const app = Fastify();
  registerReviewRoutes(app, {
    store,
    runner,
    token: TOKEN,
    org: 'market-clue',
    checkoutRoot,
    ownUser: 'richsmon',
    ownRoot,
    gh,
  });
  return { app, store, runner, checkoutRoot, ownRoot };
}

const ghOk: GhRunner = () => Promise.resolve(graphqlPayload(PR_NODES));

/** Write a session log by hand — deterministic ids/timestamps, unlike createSession. */
function writeSession(store: SessionStore, id: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(join(store.dir, `${id}.jsonl`), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
}

function createdEvent(ts: string, review?: Record<string, unknown>): Record<string, unknown> {
  return {
    ts,
    event: 'status',
    status: 'created',
    repo: 'market-clue/app',
    repoPath: '/checkouts/app',
    prompt: 'review it',
    model: 'claude-sonnet-5',
    permissionMode: 'gated',
    ...(review !== undefined ? { review } : {}),
  };
}

describe('listOpenPrs', () => {
  test('ONE GraphQL search call covers org + personal repos, newest activity first', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      return Promise.resolve(graphqlPayload(PR_NODES));
    };
    const prs = await listOpenPrs(gh, 'market-clue', 'richsmon');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(calls[0]!.join(' ')).toContain('q=org:market-clue user:richsmon is:pr is:open');

    expect(prs.map((p) => `${p.owner}/${p.repo}#${p.number}`)).toEqual([
      'richsmon/brain-intake#13',
      'market-clue/platform#94',
      'market-clue/app#90',
    ]);
    expect(prs[2]).toEqual({
      owner: 'market-clue',
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

  test('org-only search when no user is given', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      return Promise.resolve(graphqlPayload([]));
    };
    await listOpenPrs(gh, 'market-clue');
    expect(calls[0]!.join(' ')).toContain('q=org:market-clue is:pr is:open');
    expect(calls[0]!.join(' ')).not.toContain('user:');
  });

  test('drops malformed nodes instead of crashing', async () => {
    const gh: GhRunner = () =>
      Promise.resolve(graphqlPayload([{}, { number: 7, repository: { name: 'no-owner' } }, PR_NODES[0]]));
    const prs = await listOpenPrs(gh, 'market-clue', 'richsmon');
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
  test('lists open PRs across the org AND the personal repos, each row owner-tagged', async () => {
    const { app } = build(ghOk);
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const prs = res.json();
    expect(prs).toHaveLength(3);
    expect(prs[0]).toMatchObject({ owner: 'richsmon', repo: 'brain-intake', number: 13 });
    expect(prs[1]).toMatchObject({ owner: 'market-clue', repo: 'platform', number: 94, author: 'palo-kunovsky' });
  });

  test('rows carry lastReview: null when no review session was ever launched (MC-R3)', async () => {
    const { app } = build(ghOk);
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    for (const row of res.json()) expect(row.lastReview).toBeNull();
  });

  test('a reviewed PR links its MOST RECENT review session with ts/state/outcome (MC-R3)', async () => {
    const { app, store } = build(ghOk);
    // Two review sessions against market-clue/app#90 — the newer one wins.
    writeSession(store, '2026-07-21-aaaaaaaa', [
      createdEvent('2026-07-21T09:00:00Z', { owner: 'market-clue', repo: 'app', pr: 90 }),
      { ts: '2026-07-21T09:05:00Z', event: 'result', outcome: 'error', summary: 'crashed' },
      { ts: '2026-07-21T09:05:00Z', event: 'status', status: 'error' },
    ]);
    writeSession(store, '2026-07-22-bbbbbbbb', [
      createdEvent('2026-07-22T10:00:00Z', { owner: 'market-clue', repo: 'app', pr: 90 }),
      { ts: '2026-07-22T10:07:00Z', event: 'result', outcome: 'success', summary: 'LGTM' },
      { ts: '2026-07-22T10:07:00Z', event: 'status', status: 'done' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    const byKey = Object.fromEntries(
      res.json().map((r: { owner: string; repo: string; number: number }) => [`${r.owner}/${r.repo}#${r.number}`, r]),
    );
    expect(byKey['market-clue/app#90'].lastReview).toEqual({
      sessionId: '2026-07-22-bbbbbbbb',
      ts: '2026-07-22T10:00:00Z',
      state: 'done',
      outcome: 'success',
    });
    // The other PRs stay unlinked.
    expect(byKey['market-clue/platform#94'].lastReview).toBeNull();
    expect(byKey['richsmon/brain-intake#13'].lastReview).toBeNull();
  });

  test('a still-running review links without an outcome (MC-R3)', async () => {
    const { app, store } = build(ghOk);
    writeSession(store, '2026-07-22-cccccccc', [
      createdEvent('2026-07-22T11:00:00Z', { owner: 'richsmon', repo: 'brain-intake', pr: 13 }),
      { ts: '2026-07-22T11:00:01Z', event: 'status', status: 'running' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    const row = res.json().find((r: { number: number }) => r.number === 13);
    expect(row.lastReview).toEqual({
      sessionId: '2026-07-22-cccccccc',
      ts: '2026-07-22T11:00:00Z',
      state: 'running',
    });
  });

  test('pre-MC-R3 sessions (no review ref) and other-PR sessions never link', async () => {
    const { app, store } = build(ghOk);
    // Old review session from before the ref existed — indistinguishable from a coding session.
    writeSession(store, '2026-07-20-dddddddd', [
      createdEvent('2026-07-20T08:00:00Z'),
      { ts: '2026-07-20T08:09:00Z', event: 'status', status: 'done' },
    ]);
    // A review of a PR that is no longer open.
    writeSession(store, '2026-07-20-eeeeeeee', [
      createdEvent('2026-07-20T09:00:00Z', { owner: 'market-clue', repo: 'app', pr: 77 }),
      { ts: '2026-07-20T09:04:00Z', event: 'status', status: 'done' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    for (const row of res.json()) expect(row.lastReview).toBeNull();
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

    // The session shows up in the store exactly like a coding session would —
    // plus the MC-R3 review ref that links it back to the PR list.
    expect(store.readEvents(sessionId)[0]).toMatchObject({
      event: 'status',
      status: 'created',
      repo: 'market-clue/app',
      model: 'claude-opus-4-8',
      review: { owner: 'market-clue', repo: 'app', pr: 90 },
    });
  });

  test('a launched review immediately shows as lastReview on its PR row (MC-R3 round-trip)', async () => {
    const { app } = build(ghOk);
    const post = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { repo: 'app', pr: 90 },
    });
    const { sessionId } = post.json();

    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    const row = res.json().find((r: { owner: string; number: number }) => r.owner === 'market-clue' && r.number === 90);
    expect(row.lastReview).toMatchObject({ sessionId, state: 'created' });
    expect(typeof row.lastReview.ts).toBe('string');
  });

  test('owner=richsmon resolves the checkout under the personal root (MC-R2)', async () => {
    const { app, runner, ownRoot } = build(ghOk);
    const res = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { owner: 'richsmon', repo: 'brain-intake', pr: 13 },
    });
    expect(res.statusCode).toBe(201);
    const { meta } = runner.started[0]!;
    expect(meta.repo).toBe('richsmon/brain-intake');
    expect(meta.repoPath).toBe(join(ownRoot, 'brain-intake'));
    expect(meta.prompt).toContain('gh pr diff 13 --repo richsmon/brain-intake');
  });

  test('omitting owner keeps the org default — pre-MC-R2 app builds still work', async () => {
    const { app, runner, checkoutRoot } = build(ghOk);
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    expect(res.statusCode).toBe(201);
    expect(runner.started[0]!.meta.repo).toBe('market-clue/app');
    expect(runner.started[0]!.meta.repoPath).toBe(join(checkoutRoot, 'app'));
  });

  test('unknown owner ⇒ 400 — prototype keys included', async () => {
    const { app, runner } = build(ghOk);
    const bad = async (owner: string) =>
      (await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { owner, repo: 'app', pr: 90 } }))
        .statusCode;
    expect(await bad('acme')).toBe(400);
    expect(await bad('constructor')).toBe(400);
    expect(await bad('__proto__')).toBe(400);
    expect(runner.started).toHaveLength(0);
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

  test('missing personal checkout 409s under the personal root (MC-R2)', async () => {
    const { app, runner, ownRoot } = build(ghOk);
    const res = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { owner: 'richsmon', repo: 'universal-brain', pr: 35 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('no local checkout for richsmon/universal-brain');
    expect(res.json().error).toContain(join(ownRoot, 'universal-brain'));
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
    expect(await bad({ owner: 'richsmon', repo: '../universal-brain', pr: 35 })).toBe(400);
  });

  test('model defaults like the sessions route when omitted', async () => {
    const { app, runner } = build(ghOk);
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    expect(res.statusCode).toBe(201);
    expect(runner.started[0]!.opts).toEqual({ model: 'claude-sonnet-5', permissionMode: 'gated' });
  });
});

describe('buildReviewPrompt', () => {
  test('carries owner/repo/pr into every gh command it prescribes', () => {
    const prompt = buildReviewPrompt({ owner: 'market-clue', repo: 'platform', pr: 94 });
    expect(prompt).toContain('pull request #94 in market-clue/platform');
    expect(prompt).toContain('gh pr diff 94 --repo market-clue/platform');
    expect(prompt).toContain('Do not create, edit or delete any files.');
  });
});
