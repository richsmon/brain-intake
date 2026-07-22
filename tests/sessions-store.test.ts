import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SessionStore } from '../src/sessions/store.js';

function tmpStore(): SessionStore {
  return new SessionStore(mkdtempSync(join(tmpdir(), 'sessions-')));
}

const META = {
  repo: 'gotam',
  repoPath: '/checkouts/gotam',
  prompt: 'fix the login bug',
  model: 'claude-sonnet-5',
  permissionMode: 'gated',
};

describe('createSession', () => {
  test('creates {id}.jsonl whose first event is a created status carrying the meta', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);

    const events = store.readEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ index: 0, event: 'status', status: 'created', ...META });
    expect(typeof events[0]!.ts).toBe('string');
  });

  test('two sessions get distinct ids and distinct logs', () => {
    const store = tmpStore();
    const a = store.createSession(META);
    const b = store.createSession({ ...META, prompt: 'other' });
    expect(a).not.toBe(b);
    expect(store.readEvents(a)).toHaveLength(1);
    expect(store.readEvents(b)).toHaveLength(1);
  });
});

describe('appendEvent + readEvents', () => {
  test('append-only log; readEvents returns indexed events; offset replays the tail only', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    expect(store.appendEvent(id, { event: 'status', status: 'running' })).toBe(1);
    expect(store.appendEvent(id, { event: 'chat_chunk', text: 'hello' })).toBe(2);

    const all = store.readEvents(id);
    expect(all.map((e) => e.event)).toEqual(['status', 'status', 'chat_chunk']);
    expect(all.map((e) => e.index)).toEqual([0, 1, 2]);

    const tail = store.readEvents(id, 2);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ index: 2, event: 'chat_chunk', text: 'hello' });
  });

  test('log is the single source of truth — one JSON line per event on disk', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    store.appendEvent(id, { event: 'result', outcome: 'success' });
    const lines = readFileSync(join(store.dir, `${id}.jsonl`), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: 'result', outcome: 'success' });
  });

  test('malformed lines are skipped, not fatal', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    appendFileSync(join(store.dir, `${id}.jsonl`), 'not json\n');
    store.appendEvent(id, { event: 'status', status: 'running' });
    const events = store.readEvents(id);
    expect(events.map((e) => e.event)).toEqual(['status', 'status']);
  });

  test('unknown id reads as empty and has() is false', () => {
    const store = tmpStore();
    expect(store.readEvents('2026-07-22-deadbeef')).toEqual([]);
    expect(store.has('2026-07-22-deadbeef')).toBe(false);
  });
});

describe('listSessions', () => {
  test('derives state from the LAST status event; carries meta from the created event', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'status', status: 'waiting-approval' });
    store.appendEvent(id, { event: 'permission_resolved', requestId: 'r1', decision: 'approved' });
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'status', status: 'done' });

    const listed = store.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id,
      state: 'done',
      repo: 'gotam',
      model: 'claude-sonnet-5',
      permissionMode: 'gated',
    });
  });

  test('lists multiple sessions with live states', () => {
    const store = tmpStore();
    const a = store.createSession(META);
    const b = store.createSession(META);
    store.appendEvent(a, { event: 'status', status: 'running' });
    store.appendEvent(b, { event: 'status', status: 'running' });
    store.appendEvent(b, { event: 'status', status: 'paused' });

    const byId = Object.fromEntries(store.listSessions().map((s) => [s.id, s.state]));
    expect(byId[a]).toBe('running');
    expect(byId[b]).toBe('paused');
  });

  test('surfaces usage + total_cost_usd from the LAST result event (BI-C5)', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    store.appendEvent(id, {
      event: 'result',
      outcome: 'success',
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.01,
    });
    // Second turn: the SDK's counters are session-cumulative — last result wins.
    store.appendEvent(id, {
      event: 'result',
      outcome: 'success',
      usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 5000, cache_read_input_tokens: 88000 },
      total_cost_usd: 0.4321,
    });
    store.appendEvent(id, { event: 'status', status: 'done' });

    expect(store.listSessions()[0]).toMatchObject({
      usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 5000, cache_read_input_tokens: 88000 },
      total_cost_usd: 0.4321,
    });
  });

  test('sessions whose result carries no usage omit the fields entirely (BI-C5)', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    store.appendEvent(id, { event: 'result', outcome: 'success' });
    store.appendEvent(id, { event: 'status', status: 'done' });

    const listed = store.listSessions()[0]!;
    expect('usage' in listed).toBe(false);
    expect('total_cost_usd' in listed).toBe(false);
  });
});

describe('subscribe', () => {
  test('listener receives appended events with their index; unsubscribe stops delivery', () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const seen: Array<{ index: number; event: string }> = [];
    const unsubscribe = store.subscribe(id, (e) => seen.push({ index: e.index, event: e.event }));

    store.appendEvent(id, { event: 'chat_chunk', text: 'hi' });
    expect(seen).toEqual([{ index: 1, event: 'chat_chunk' }]);

    unsubscribe();
    store.appendEvent(id, { event: 'status', status: 'done' });
    expect(seen).toHaveLength(1);
  });

  test('subscription is per-session', () => {
    const store = tmpStore();
    const a = store.createSession(META);
    const b = store.createSession(META);
    const seen: string[] = [];
    store.subscribe(a, (e) => seen.push(e.event));
    store.appendEvent(b, { event: 'chat_chunk', text: 'other session' });
    expect(seen).toEqual([]);
  });
});
