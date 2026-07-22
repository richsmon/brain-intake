import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, test } from 'vitest';
import { DEFAULT_BASH_ALLOWLIST } from '../src/config.js';
import { SessionStore, type SessionMeta } from '../src/sessions/store.js';
import type { SessionRunnerLike } from '../src/sessions/routes.js';
import { listOpenPrs } from '../src/reviews/prs.js';
import { buildFullReviewPrompt, buildReviewPrompt } from '../src/reviews/prompt.js';
import { registerReviewRoutes } from '../src/reviews/routes.js';
import type { GhRunner } from '../src/reviews/gh.js';
import { fullReviewBashAllowlist, type GitRunner } from '../src/reviews/worktree.js';

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

interface BuildOptions {
  /** MC-R6: whether the MC brain checkout exists at `{checkoutRoot}/brain`. */
  mcBrain?: boolean;
  /** MC-R6: override the injected git runner (defaults to record-and-succeed). */
  git?: GitRunner;
}

function build(
  gh: GhRunner,
  opts: BuildOptions = {},
): {
  app: FastifyInstance;
  store: SessionStore;
  runner: FakeRunner;
  checkoutRoot: string;
  ownRoot: string;
  worktreeBase: string;
  gitCalls: string[][];
} {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'reviews-sessions-')));
  const runner = new FakeRunner();
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'mc-checkouts-'));
  mkdirSync(join(checkoutRoot, 'app'));
  if (opts.mcBrain !== false) mkdirSync(join(checkoutRoot, 'brain'));
  const ownRoot = mkdtempSync(join(tmpdir(), 'own-checkouts-'));
  mkdirSync(join(ownRoot, 'brain-intake'));
  const worktreeBase = mkdtempSync(join(tmpdir(), 'wt-base-'));
  const gitCalls: string[][] = [];
  const git: GitRunner =
    opts.git ??
    ((args) => {
      gitCalls.push(args);
      return Promise.resolve('');
    });
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
    git,
    worktreeBase,
  });
  return { app, store, runner, checkoutRoot, ownRoot, worktreeBase, gitCalls };
}

/** gh fake: answers the PR-listing GraphQL search AND the MC-R6
 * `gh pr view --json headRefName` worktree-prep call. */
const ghOk: GhRunner = (args) => {
  if (args[0] === 'pr' && args[1] === 'view') {
    const pr = Number(args[2]);
    const node = PR_NODES.find((n) => n.number === pr);
    return Promise.resolve(JSON.stringify({ headRefName: node?.headRefName ?? 'main' }));
  }
  return Promise.resolve(graphqlPayload(PR_NODES));
};

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

  test('org rows are tagged fullReview: true, personal rows false (MC-R6)', async () => {
    const { app } = build(ghOk);
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    const byKey = Object.fromEntries(
      res.json().map((r: { owner: string; number: number; fullReview: boolean }) => [`${r.owner}#${r.number}`, r]),
    );
    expect(byKey['market-clue#94'].fullReview).toBe(true);
    expect(byKey['market-clue#90'].fullReview).toBe(true);
    expect(byKey['richsmon#13'].fullReview).toBe(false);
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
      // MC-R4: the summary had no findings-json block — null, never an error.
      findings: null,
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

  test('a done review with a findings block carries verdict + counts by severity (MC-R4)', async () => {
    const { app, store } = build(ghOk);
    const summary = [
      'Two problems worth fixing before merge.',
      '```findings-json',
      JSON.stringify({
        verdict: 'request-changes',
        findings: [
          { severity: 'high', file: 'src/auth.ts', line: 12, title: 'Token logged', detail: 'Redact it.' },
          { severity: 'high', title: 'Missing rate limit', detail: 'Add one.' },
          { severity: 'low', title: 'Naming nit', detail: 'Rename.' },
        ],
      }),
      '```',
    ].join('\n');
    writeSession(store, '2026-07-22-ffffffff', [
      createdEvent('2026-07-22T12:00:00Z', { owner: 'market-clue', repo: 'app', pr: 90 }),
      { ts: '2026-07-22T12:09:00Z', event: 'result', outcome: 'success', summary },
      { ts: '2026-07-22T12:09:00Z', event: 'status', status: 'done' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    const row = res.json().find((r: { owner: string; number: number }) => r.owner === 'market-clue' && r.number === 90);
    expect(row.lastReview.findings).toEqual({
      verdict: 'request-changes',
      counts: { high: 2, medium: 0, low: 1 },
      total: 3,
    });
  });

  test('a malformed findings block ⇒ lastReview.findings null; a running review omits the field (MC-R4)', async () => {
    const { app, store } = build(ghOk);
    writeSession(store, '2026-07-22-gggggggg', [
      createdEvent('2026-07-22T12:00:00Z', { owner: 'market-clue', repo: 'app', pr: 90 }),
      { ts: '2026-07-22T12:09:00Z', event: 'result', outcome: 'success', summary: '```findings-json\n{broken\n```' },
      { ts: '2026-07-22T12:09:00Z', event: 'status', status: 'done' },
    ]);
    writeSession(store, '2026-07-22-hhhhhhhh', [
      createdEvent('2026-07-22T13:00:00Z', { owner: 'richsmon', repo: 'brain-intake', pr: 13 }),
      { ts: '2026-07-22T13:00:01Z', event: 'status', status: 'running' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    const rows = res.json();
    const done = rows.find((r: { number: number }) => r.number === 90);
    expect(done.lastReview.findings).toBeNull();
    const running = rows.find((r: { number: number }) => r.number === 13);
    expect('findings' in running.lastReview).toBe(false);
  });

  test('gh failure ⇒ 502, mirroring the approvals routes', async () => {
    const { app } = build(() => Promise.reject(new Error('gh exploded')));
    const res = await app.inject({ method: 'GET', url: '/reviews/prs', headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'gh unavailable' });
  });
});

describe('POST /reviews — read-only quick look (non-org owners)', () => {
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

  test('MC-R6 regression: a richsmon review is the OLD flow byte-for-byte — gated, read-only brief, no worktree, no allowlist extension', async () => {
    const { app, store, runner, ownRoot, gitCalls } = build(ghOk);
    const res = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { owner: 'richsmon', repo: 'brain-intake', pr: 13, model: 'claude-opus-4-8', effort: 'high' },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json();

    const { meta, opts } = runner.started[0]!;
    expect(meta.permissionMode).toBe('gated');
    expect(meta.repoPath).toBe(join(ownRoot, 'brain-intake'));
    expect(meta.prompt).toBe(buildReviewPrompt({ owner: 'richsmon', repo: 'brain-intake', pr: 13 }));
    // No session-scoped allowlist extension, no worktree — no git calls at all.
    expect(opts).toEqual({ model: 'claude-opus-4-8', permissionMode: 'gated', effort: 'high' });
    expect(gitCalls).toHaveLength(0);

    // Reaching a terminal state never triggers worktree cleanup either.
    store.appendEvent(sessionId, { event: 'status', status: 'done' });
    await new Promise((r) => setImmediate(r));
    expect(gitCalls).toHaveLength(0);
  });

  test('the read-only brief fetches the diff and forbids any GitHub write', async () => {
    const { app, runner } = build(ghOk);
    await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { owner: 'richsmon', repo: 'brain-intake', pr: 13 },
    });
    const prompt = runner.started[0]!.meta.prompt;
    expect(prompt).toContain('gh pr view 13 --repo richsmon/brain-intake');
    expect(prompt).toContain('gh pr diff 13 --repo richsmon/brain-intake');
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('never post comments');
    expect(prompt).toContain('never push');
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

  test('model defaults like the sessions route when omitted', async () => {
    const { app, runner } = build(ghOk);
    const res = await app.inject({
      method: 'POST',
      url: '/reviews',
      headers: AUTH,
      payload: { owner: 'richsmon', repo: 'brain-intake', pr: 13 },
    });
    expect(res.statusCode).toBe(201);
    expect(runner.started[0]!.opts).toEqual({ model: 'claude-sonnet-5', permissionMode: 'gated' });
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

  test('repo without a local checkout ⇒ 409 with the expected path — never clones, never preps a worktree', async () => {
    const { app, runner, checkoutRoot, gitCalls } = build(ghOk);
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
    expect(gitCalls).toHaveLength(0);
  });
});

describe('POST /reviews — full MC flow (MC-R6)', () => {
  test('launches an acceptEdits session INSIDE a fresh worktree at the PR head', async () => {
    const { app, store, runner, checkoutRoot, worktreeBase, gitCalls } = build(ghOk);
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
    const wtPath = meta.repoPath;

    // The worktree is unique, under the configured base, and IS the session cwd.
    expect(wtPath.startsWith(join(worktreeBase, 'mc-review-app-pr-90-'))).toBe(true);
    expect(wtPath).not.toBe(join(checkoutRoot, 'app'));

    // Worktree prepared before the session: fetch the PR head, add detached.
    const appCheckout = join(checkoutRoot, 'app');
    expect(gitCalls).toEqual([
      ['-C', appCheckout, 'fetch', 'origin', 'login-pages'],
      ['-C', appCheckout, 'worktree', 'add', '--detach', wtPath, 'FETCH_HEAD'],
    ]);

    expect(meta.repo).toBe('market-clue/app');
    expect(meta.permissionMode).toBe('acceptEdits');
    expect(meta.review).toEqual({ owner: 'market-clue', repo: 'app', pr: 90 });
    expect(opts).toMatchObject({ model: 'claude-opus-4-8', permissionMode: 'acceptEdits', effort: 'high' });
  });

  test('the session-scoped allowlist extension carries the EXACT prefixes for this one review', async () => {
    const { app, runner, checkoutRoot } = build(ghOk);
    await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    const { meta, opts } = runner.started[0]!;
    const wt = meta.repoPath;
    const mb = join(checkoutRoot, 'brain');
    expect((opts as { extraBashAllowlist: string[] }).extraBashAllowlist).toEqual([
      `git -C ${wt} add`,
      `git -C ${wt} commit`,
      `git -C ${wt} push`,
      `git -C ${wt} switch`,
      `git -C ${mb} status`,
      `git -C ${mb} diff`,
      `git -C ${mb} log`,
      `git -C ${mb} fetch`,
      `git -C ${mb} switch`,
      `git -C ${mb} add`,
      `git -C ${mb} commit`,
      `git -C ${mb} push`,
      `gh pr create --repo market-clue/brain`,
      `gh pr comment 90 --repo market-clue/app`,
      `gh pr review 90 --repo market-clue/app`,
    ]);
  });

  test('worktree is removed server-side on the FIRST terminal transition, exactly once', async () => {
    const { app, store, runner, checkoutRoot, gitCalls } = build(ghOk);
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    const { sessionId } = res.json();
    const wtPath = runner.started[0]!.meta.repoPath;
    const appCheckout = join(checkoutRoot, 'app');
    const removals = () =>
      gitCalls.filter((c) => c.includes('remove')).map((c) => c.slice(2));

    // Non-terminal statuses never reap.
    store.appendEvent(sessionId, { event: 'status', status: 'running' });
    store.appendEvent(sessionId, { event: 'status', status: 'waiting-approval' });
    await new Promise((r) => setImmediate(r));
    expect(removals()).toHaveLength(0);

    // First terminal transition reaps…
    store.appendEvent(sessionId, { event: 'status', status: 'done' });
    await new Promise((r) => setImmediate(r));
    expect(gitCalls).toContainEqual(['-C', appCheckout, 'worktree', 'remove', '--force', wtPath]);
    expect(removals()).toHaveLength(1);

    // …and only the first — later events change nothing.
    store.appendEvent(sessionId, { event: 'status', status: 'done' });
    await new Promise((r) => setImmediate(r));
    expect(removals()).toHaveLength(1);
  });

  test('paused and error count as terminal for worktree cleanup too', async () => {
    for (const status of ['paused', 'error']) {
      const { app, store, runner, gitCalls } = build(ghOk);
      const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
      const { sessionId } = res.json();
      const wtPath = runner.started[0]!.meta.repoPath;
      store.appendEvent(sessionId, { event: 'status', status });
      await new Promise((r) => setImmediate(r));
      expect(gitCalls.some((c) => c.includes('remove') && c.includes(wtPath))).toBe(true);
    }
  });

  test('missing MC brain checkout ⇒ 409, nothing launched, no worktree', async () => {
    const { app, runner, checkoutRoot, gitCalls } = build(ghOk, { mcBrain: false });
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('no local checkout of the MC brain');
    expect(res.json().error).toContain(join(checkoutRoot, 'brain'));
    expect(runner.started).toHaveLength(0);
    expect(gitCalls).toHaveLength(0);
  });

  test('gh headRefName failure ⇒ 502, no session created', async () => {
    const gh: GhRunner = (args) =>
      args[0] === 'pr' ? Promise.reject(new Error('gh pr view failed')) : Promise.resolve(graphqlPayload(PR_NODES));
    const { app, store, runner } = build(gh);
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('worktree setup failed');
    expect(runner.started).toHaveLength(0);
    expect(store.listSessions()).toHaveLength(0);
  });

  test('worktree add failure ⇒ 502, no session created', async () => {
    const { app, store, runner } = build(ghOk, { git: () => Promise.reject(new Error('worktree add exploded')) });
    const res = await app.inject({ method: 'POST', url: '/reviews', headers: AUTH, payload: { repo: 'app', pr: 90 } });
    expect(res.statusCode).toBe(502);
    expect(runner.started).toHaveLength(0);
    expect(store.listSessions()).toHaveLength(0);
  });

  test('a launched full review immediately shows as lastReview on its PR row (MC-R3 round-trip)', async () => {
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
});

describe('buildReviewPrompt', () => {
  test('carries owner/repo/pr into every gh command it prescribes', () => {
    const prompt = buildReviewPrompt({ owner: 'market-clue', repo: 'platform', pr: 94 });
    expect(prompt).toContain('pull request #94 in market-clue/platform');
    expect(prompt).toContain('gh pr diff 94 --repo market-clue/platform');
    expect(prompt).toContain('Do not create, edit or delete any files.');
  });

  test('demands the fenced findings-json tail with the exact contract vocabulary (MC-R4)', () => {
    const prompt = buildReviewPrompt({ owner: 'market-clue', repo: 'platform', pr: 94 });
    expect(prompt).toContain('```findings-json');
    expect(prompt).toContain('"verdict": "approve" | "request-changes" | "comment"');
    expect(prompt).toContain('"severity": "high" | "medium" | "low"');
    expect(prompt).toContain('LAST thing in the message');
    expect(prompt).toContain('{"verdict": "approve", "findings": []}');
  });
});

describe('buildFullReviewPrompt (MC-R6)', () => {
  const input = {
    owner: 'market-clue',
    repo: 'platform',
    pr: 94,
    branch: 'MC-74/dashboard-aggregation-hardening',
    worktreePath: '/wts/mc-review-platform-pr-94-ab12cd34',
    mcBrainPath: '/checkouts/market-clue/brain',
  };
  const prompt = buildFullReviewPrompt(input);

  test('pins the session to the worktree and the MC brain checkout, and forbids everything else', () => {
    expect(prompt).toContain('FULL code review of pull request #94 in market-clue/platform');
    expect(prompt).toContain('/wts/mc-review-platform-pr-94-ab12cd34');
    expect(prompt).toContain('/checkouts/market-clue/brain');
    expect(prompt).toContain('Touch NOTHING outside the worktree');
    expect(prompt).toContain("never modify this PR's source branch");
    expect(prompt).toContain('never merge');
  });

  test('restates the richsmon identity rule hard — human-authored, signed, zero AI traces', () => {
    expect(prompt).toContain('MUST read as authored by richsmon');
    expect(prompt).toContain('ZERO mentions of AI, Claude, agents or assistants');
    expect(prompt).toContain('NO Co-Authored-By');
    expect(prompt).toContain('signed automatically');
    expect(prompt).toContain('never touch git config');
  });

  test('encodes the brain-pr-review doc conventions: MC-key resolution, doc path, fallbacks', () => {
    expect(prompt).toContain('MC Story key');
    expect(prompt).toContain('first from the branch name');
    expect(prompt).toContain('workspaces/{workspace}/features/{feature}/reviews/{MC-key}--platform-pr-94.md');
    expect(prompt).toContain('workspaces/{workspace}/reviews/');
    expect(prompt).toContain('keyless lane');
    expect(prompt).toContain('grep -rl "MC-{n}" workspaces/*/features/*/plan.md');
  });

  test('opens the brain PR on the mc-review branch from origin/main and never merges it', () => {
    expect(prompt).toContain('mc-review/platform-pr-94');
    expect(prompt).toContain('switch -c mc-review/platform-pr-94 origin/main');
    expect(prompt).toContain('gh pr create --repo market-clue/brain');
    expect(prompt).toContain('Do NOT merge it');
  });

  test('platform feedback is verdict-conditional — approve ONLY on an approve verdict', () => {
    expect(prompt).toContain('STRICTLY verdict-conditional');
    expect(prompt).toContain('Verdict approve ⇒ `gh pr review 94 --repo market-clue/platform --approve');
    expect(prompt).toContain('Approve ONLY on a genuine approve verdict');
    expect(prompt).toContain('hollow approve is worse than none');
    expect(prompt).toContain('Verdict request-changes ⇒ `gh pr review 94 --repo market-clue/platform --request-changes');
    expect(prompt).toContain('Verdict comment ⇒ `gh pr review 94 --repo market-clue/platform --comment');
    expect(prompt).toContain('gh pr comment 94 --repo market-clue/platform --body');
  });

  test('keeps the findings-json tail and demands the Brain PR line before it', () => {
    expect(prompt).toContain('```findings-json');
    expect(prompt).toContain('"verdict": "approve" | "request-changes" | "comment"');
    expect(prompt).toContain('LAST thing in the message');
    expect(prompt).toContain('Brain PR: <url>');
    expect(prompt).toContain('the `Brain PR:` line comes BEFORE it');
  });

  test('every git/gh command the brief prescribes passes the session allowlist (default + scoped extension)', () => {
    const allow = [...DEFAULT_BASH_ALLOWLIST, ...fullReviewBashAllowlist(input)];
    const commands = [...prompt.matchAll(/`((?:git|gh) [^`]+)`/g)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThan(8);
    for (const command of commands) {
      const passes = allow.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
      expect(passes, `not allowlisted: ${command}`).toBe(true);
    }
  });
});
