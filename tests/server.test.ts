import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { appendEvent, readEvents } from '../src/inbox.js';
import { buildServer } from '../src/server.js';
import type { SessionSdk } from '../src/sessions/runner.js';

function tmpBrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  mkdirSync(join(root, 'inbox'));
  return root;
}

describe('GET /health', () => {
  test('reports ok + brainRoot (the app uses this as its reachability probe)', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, brainRoot: root });
  });
});

describe('POST /items (JSON: text / share-sheet)', () => {
  test('creates an inbox item with captured + queued events', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { source: 'text', text: 'a thought from the phone', deviceTs: '2026-07-07T10:00:00Z' },
    });

    expect(res.statusCode).toBe(201);
    const { id, deduped } = res.json();
    expect(deduped).toBe(false);

    const events = readEvents(join(root, 'inbox', id));
    expect(events.map((e) => e.event)).toEqual(['captured', 'queued']);
    expect(events[0]).toMatchObject({ source: 'text', device_ts: '2026-07-07T10:00:00Z' });
  });

  test('same text twice → deduped', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const payload = { source: 'share-sheet', text: 'https://example.com/article' };
    const first = (await app.inject({ method: 'POST', url: '/items', payload })).json();
    const res = await app.inject({ method: 'POST', url: '/items', payload });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: first.id, deduped: true });
  });

  test('rejects missing text and non-JSON sources with 400', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    expect((await app.inject({ method: 'POST', url: '/items', payload: { source: 'text' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/items', payload: { source: 'voice', text: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/items', payload: { source: 'nope', text: 'x' } })).statusCode).toBe(400);
  });
});

describe('GET /items', () => {
  test('lists items with state, lastEvent and title from classified', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const { id } = (
      await app.inject({ method: 'POST', url: '/items', payload: { source: 'text', text: 'listable' } })
    ).json();
    appendEvent(join(root, 'inbox', id), {
      event: 'classified', type: 'note', workspace: 'brain', title: 'A listable thought', confidence: 0.9,
    });

    const res = await app.inject({ method: 'GET', url: '/items' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id, state: 'open', lastEvent: 'classified', title: 'A listable thought' },
    ]);
  });

  test('exposes what the item became — kind from the became event', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const { id } = (
      await app.inject({ method: 'POST', url: '/items', payload: { source: 'text', text: 'becomes a note' } })
    ).json();
    appendEvent(join(root, 'inbox', id), {
      event: 'became', artifact: 'workspaces/x/knowledge/n.md', kind: 'note',
    });

    const res = await app.inject({ method: 'GET', url: '/items' });
    expect(res.json()).toEqual([
      { id, state: 'became', lastEvent: 'became', kind: 'note' },
    ]);
  });
});

describe('GET /items/:id', () => {
  test('returns the full event trail + payload ref', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const { id } = (
      await app.inject({ method: 'POST', url: '/items', payload: { source: 'text', text: 'detail me' } })
    ).json();

    const res = await app.inject({ method: 'GET', url: `/items/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.state).toBe('open');
    expect(body.events.map((e: { event: string }) => e.event)).toEqual(['captured', 'queued']);
    expect(body.payload).toEqual({ name: 'payload.md', bytes: 'detail me'.length });
    expect(body.transcript).toBeUndefined();
  });

  test('returns the transcript text when transcript.md exists (voice items)', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const { id } = (
      await app.inject({ method: 'POST', url: '/items', payload: { source: 'text', text: 'voice-ish' } })
    ).json();
    writeFileSync(join(root, 'inbox', id, 'transcript.md'), 'the spoken thought');

    const res = await app.inject({ method: 'GET', url: `/items/${id}` });
    expect(res.json().transcript).toBe('the spoken thought');
  });

  test('unknown id → 404', async () => {
    const app = buildServer({ brainRoot: tmpBrain() });
    expect((await app.inject({ method: 'GET', url: '/items/2026-07-07-deadbeef' })).statusCode).toBe(404);
  });
});

describe('sessions wiring (BI-C1)', () => {
  test('no sessions config ⇒ sessions routes absent (404, not 401)', async () => {
    const app = buildServer({ brainRoot: tmpBrain() });
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(404);
  });

  test('with sessions config + token, buildServer mounts the guarded sessions API', async () => {
    const root = tmpBrain();
    const sessionsDir = mkdtempSync(join(tmpdir(), 'sess-'));
    const repoPath = mkdtempSync(join(tmpdir(), 'gotam-'));
    // Fake Agent SDK: one text chunk then a success result — no network.
    const sdk: SessionSdk = () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'result', subtype: 'success' },
      ];
      let i = 0;
      return {
        setPermissionMode: () => Promise.resolve(),
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              Promise.resolve(
                i < messages.length
                  ? { value: messages[i++]!, done: false }
                  : { value: undefined as never, done: true },
              ),
          };
        },
      };
    };

    const app = buildServer({
      brainRoot: root,
      sessions: {
        sessionsDir,
        repoAllowlist: { gotam: repoPath },
        bashAllowlist: ['git status'],
        approvalTimeoutMin: 30,
        token: 'tok',
        models: [{ id: 'claude-sonnet-5', label: 'Sonnet' }],
        efforts: ['high'],
        sdk,
      },
    });

    expect((await app.inject({ method: 'GET', url: '/sessions' })).statusCode).toBe(401);
    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: 'Bearer tok' },
      payload: { repo: 'gotam', prompt: 'hi' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(typeof id).toBe('string');

    const list = await app.inject({ method: 'GET', url: '/sessions', headers: { authorization: 'Bearer tok' } });
    expect(list.json().some((s: { id: string }) => s.id === id)).toBe(true);
  });
});
