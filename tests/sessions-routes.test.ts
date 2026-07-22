import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { describe, expect, test } from 'vitest';
import { SessionStore } from '../src/sessions/store.js';
import { registerSessionRoutes, type SessionRunnerLike } from '../src/sessions/routes.js';

const TOKEN = 'test-bearer-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

class FakeRunner implements SessionRunnerLike {
  started: Array<{ id: string; opts: unknown }> = [];
  approvals: string[] = [];
  denials: string[] = [];
  modes: string[] = [];
  messages: string[] = [];
  approveResult = true;
  setModeResult = true;
  sendResult = true;
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  run(id: string, _meta: unknown, opts?: unknown): Promise<void> {
    this.started.push({ id, opts });
    this.store.appendEvent(id, { event: 'status', status: 'running' });
    return Promise.resolve();
  }
  approve(_id: string, requestId: string): boolean {
    this.approvals.push(requestId);
    return this.approveResult;
  }
  deny(_id: string, requestId: string): boolean {
    this.denials.push(requestId);
    return this.approveResult;
  }
  setMode(_id: string, mode: 'gated' | 'acceptEdits' | 'auto'): Promise<boolean> {
    this.modes.push(mode);
    return Promise.resolve(this.setModeResult);
  }
  sendMessage(_id: string, text: string): boolean {
    this.messages.push(text);
    return this.sendResult;
  }
}

const MODELS = [
  { id: 'claude-fable-5', label: 'Fable' },
  { id: 'claude-sonnet-5', label: 'Sonnet' },
];
const EFFORTS = ['low', 'high'];

function build(opts: {
  whisperCmd?: string;
  runCommand?: (cmd: string) => Promise<string>;
} = {}): { app: FastifyInstance; store: SessionStore; runner: FakeRunner; repoPath: string } {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'routes-')));
  const runner = new FakeRunner(store);
  const repoPath = mkdtempSync(join(tmpdir(), 'gotam-'));
  const app = Fastify();
  // Production registers multipart on the app before the sessions plugin
  // (src/server.ts) — the transcribe route inherits it the same way here.
  void app.register(multipart);
  registerSessionRoutes(app, {
    store,
    runner,
    repoAllowlist: { gotam: repoPath },
    token: TOKEN,
    models: MODELS,
    efforts: EFFORTS,
    ...(opts.whisperCmd !== undefined ? { whisperCmd: opts.whisperCmd } : {}),
    ...(opts.runCommand !== undefined ? { transcribeDeps: { runCommand: opts.runCommand } } : {}),
  });
  return { app, store, runner, repoPath };
}

function audioForm(fileName: string, content: Buffer): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(content)]), fileName);
  return fd;
}

describe('bearer-token guard', () => {
  test('every sessions route rejects a missing/wrong token with 401', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/sessions' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/sessions', headers: { authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/sessions', payload: { repo: 'gotam', prompt: 'x' } })).statusCode,
    ).toBe(401);
  });
});

describe('POST /sessions', () => {
  test('creates a session in an allowlisted repo, starts the runner, returns 201 {id}', async () => {
    const { app, store, runner } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { repo: 'gotam', prompt: 'fix login', model: 'claude-opus-4-8', permissionMode: 'gated' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect(store.has(id)).toBe(true);
    expect(runner.started).toHaveLength(1);
    expect(runner.started[0]!.id).toBe(id);
    expect(store.readEvents(id)[0]).toMatchObject({ event: 'status', status: 'created', repo: 'gotam' });
  });

  test('accepts permissionMode auto and hands it to the runner (BI-C4)', async () => {
    const { app, store, runner } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { repo: 'gotam', prompt: 'ship it', permissionMode: 'auto' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect(runner.started[0]!.opts).toMatchObject({ permissionMode: 'auto' });
    expect(store.readEvents(id)[0]).toMatchObject({ event: 'status', status: 'created', permissionMode: 'auto' });
  });

  test('an unknown permissionMode falls back to gated', async () => {
    const { app, runner } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { repo: 'gotam', prompt: 'x', permissionMode: 'yolo' },
    });
    expect(res.statusCode).toBe(201);
    expect(runner.started[0]!.opts).toMatchObject({ permissionMode: 'gated' });
  });

  test('unknown repo ⇒ 400; missing prompt ⇒ 400', async () => {
    const { app } = build();
    expect(
      (await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: { repo: 'nope', prompt: 'x' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: { repo: 'gotam' } })).statusCode,
    ).toBe(400);
  });
});

describe('GET /sessions', () => {
  test('lists sessions with live states', async () => {
    const { app } = build();
    await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: { repo: 'gotam', prompt: 'a' } });
    const res = await app.inject({ method: 'GET', url: '/sessions', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ repo: 'gotam', state: 'running' });
  });
});

describe('GET /sessions/:id/events (SSE replay)', () => {
  test('unknown id ⇒ 404', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/sessions/nope/events', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  test('replays the full JSONL trail for a terminal session, then closes', async () => {
    const { app, store } = build();
    const id = store.createSession({
      repo: 'gotam',
      repoPath: '/x',
      prompt: 'p',
      model: 'm',
      permissionMode: 'gated',
    });
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'chat_chunk', text: 'hello' });
    store.appendEvent(id, { event: 'result', outcome: 'success' });
    store.appendEvent(id, { event: 'status', status: 'done' });

    const res = await app.inject({ method: 'GET', url: `/sessions/${id}/events`, headers: AUTH });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const frames = res.payload
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)));
    expect(frames.map((f) => f.event)).toEqual(['status', 'status', 'chat_chunk', 'result', 'status']);
    expect(frames.map((f) => f.index)).toEqual([0, 1, 2, 3, 4]);
  });

  test('?offset= replays only the tail — no gaps, no duplicates on re-attach', async () => {
    const { app, store } = build();
    const id = store.createSession({
      repo: 'gotam',
      repoPath: '/x',
      prompt: 'p',
      model: 'm',
      permissionMode: 'gated',
    });
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'chat_chunk', text: 'a' });
    store.appendEvent(id, { event: 'chat_chunk', text: 'b' });
    store.appendEvent(id, { event: 'status', status: 'done' });

    // created(0) running(1) chat:a(2) chat:b(3) done(4) — re-attach from offset 3
    const res = await app.inject({ method: 'GET', url: `/sessions/${id}/events?offset=3`, headers: AUTH });
    const frames = res.payload
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)));
    expect(frames.map((f) => f.index)).toEqual([3, 4]);
    expect(frames[0]).toMatchObject({ event: 'chat_chunk', text: 'b' });
  });
});

describe('GET /sessions/meta (BI-C2)', () => {
  test('serves repos, models and efforts from config — the single picker source', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/sessions/meta', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repos: ['gotam'], models: MODELS, efforts: EFFORTS });
  });

  test('requires the bearer token like every sessions route', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/sessions/meta' })).statusCode).toBe(401);
  });
});

describe('GET /sessions/:id/events.json (BI-C2 poll snapshot)', () => {
  test('unknown id ⇒ 404; missing token ⇒ 401', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/sessions/nope/events.json', headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/sessions/nope/events.json' })).statusCode).toBe(401);
  });

  test('returns {events, nextOffset, state} for the full trail', async () => {
    const { app, store } = build();
    const id = store.createSession({ repo: 'gotam', repoPath: '/x', prompt: 'p', model: 'm', permissionMode: 'gated' });
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'chat_chunk', text: 'hello' });

    const res = await app.inject({ method: 'GET', url: `/sessions/${id}/events.json`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe('running');
    expect(body.nextOffset).toBe(3);
    expect(body.events.map((e: { event: string }) => e.event)).toEqual(['status', 'status', 'chat_chunk']);
    expect(body.events.map((e: { index: number }) => e.index)).toEqual([0, 1, 2]);
  });

  test('?offset= returns only the tail; nextOffset advances so repolling has no gaps or duplicates', async () => {
    const { app, store } = build();
    const id = store.createSession({ repo: 'gotam', repoPath: '/x', prompt: 'p', model: 'm', permissionMode: 'gated' });
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'chat_chunk', text: 'a' });

    const first = (await app.inject({ method: 'GET', url: `/sessions/${id}/events.json?offset=0`, headers: AUTH })).json();
    expect(first.nextOffset).toBe(3);

    // nothing new yet — an empty page, same nextOffset
    const idle = (await app.inject({ method: 'GET', url: `/sessions/${id}/events.json?offset=${first.nextOffset}`, headers: AUTH })).json();
    expect(idle.events).toEqual([]);
    expect(idle.nextOffset).toBe(3);

    store.appendEvent(id, { event: 'chat_chunk', text: 'b' });
    store.appendEvent(id, { event: 'status', status: 'done' });
    const tail = (await app.inject({ method: 'GET', url: `/sessions/${id}/events.json?offset=${idle.nextOffset}`, headers: AUTH })).json();
    expect(tail.events.map((e: { index: number }) => e.index)).toEqual([3, 4]);
    expect(tail.state).toBe('done');
    expect(tail.nextOffset).toBe(5);
  });
});

describe('approve / deny / mode / message', () => {
  test('approve routes to runner.approve; unknown id ⇒ 404; no pending ⇒ 409', async () => {
    const { app, store, runner } = build();
    const id = store.createSession({ repo: 'gotam', repoPath: '/x', prompt: 'p', model: 'm', permissionMode: 'gated' });

    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/approve`, headers: AUTH, payload: { requestId: 'r1' } }))
        .statusCode,
    ).toBe(200);
    expect(runner.approvals).toEqual(['r1']);

    expect(
      (await app.inject({ method: 'POST', url: '/sessions/nope/approve', headers: AUTH, payload: { requestId: 'r1' } }))
        .statusCode,
    ).toBe(404);

    runner.approveResult = false;
    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/approve`, headers: AUTH, payload: { requestId: 'x' } }))
        .statusCode,
    ).toBe(409);
  });

  test('deny, mode and message routes forward to the runner with validation', async () => {
    const { app, store, runner } = build();
    const id = store.createSession({ repo: 'gotam', repoPath: '/x', prompt: 'p', model: 'm', permissionMode: 'gated' });

    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/deny`, headers: AUTH, payload: { requestId: 'r9', message: 'no' } }))
        .statusCode,
    ).toBe(200);
    expect(runner.denials).toEqual(['r9']);

    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/mode`, headers: AUTH, payload: { mode: 'acceptEdits' } }))
        .statusCode,
    ).toBe(200);
    expect(runner.modes).toEqual(['acceptEdits']);
    // BI-C4: the mid-session flip accepts auto too.
    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/mode`, headers: AUTH, payload: { mode: 'auto' } }))
        .statusCode,
    ).toBe(200);
    expect(runner.modes).toEqual(['acceptEdits', 'auto']);
    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/mode`, headers: AUTH, payload: { mode: 'bogus' } }))
        .statusCode,
    ).toBe(400);

    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/message`, headers: AUTH, payload: { text: 'keep going' } }))
        .statusCode,
    ).toBe(200);
    expect(runner.messages).toEqual(['keep going']);
    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/message`, headers: AUTH, payload: { text: '  ' } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('POST /sessions/transcribe (BI-C6 prompt dictation)', () => {
  test('runs WHISPER_CMD on the uploaded audio and returns the cleaned transcript', async () => {
    const commands: string[] = [];
    const { app } = build({
      whisperCmd: 'stt {input}',
      runCommand: async (cmd) => {
        commands.push(cmd);
        // Prove the payload actually landed at the path handed to the command.
        const path = /'(.+)'/.exec(cmd)![1]!;
        expect(readFileSync(path, 'utf-8')).toBe('fake-audio');
        return 'Add voice input to the prompt.\nThank you for watching.\n';
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/transcribe',
      headers: AUTH,
      payload: audioForm('dictation.m4a', Buffer.from('fake-audio')),
    });
    expect(res.statusCode).toBe(200);
    // Whisper phantom lines are filtered exactly like the capture flow.
    expect(res.json()).toEqual({ text: 'Add voice input to the prompt.' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^stt '.*audio\.m4a'$/);
  });

  test('WHISPER_CMD unset ⇒ 503 so the app can fall back to typing', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/transcribe',
      headers: AUTH,
      payload: audioForm('dictation.m4a', Buffer.from('x')),
    });
    expect(res.statusCode).toBe(503);
  });

  test('requires the bearer token like every sessions route', async () => {
    const { app } = build({ whisperCmd: 'stt', runCommand: async () => 'hi' });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/transcribe',
      payload: audioForm('dictation.m4a', Buffer.from('x')),
    });
    expect(res.statusCode).toBe(401);
  });

  test('non-audio extension ⇒ 400; whisper failure ⇒ 502; silence ⇒ 200 with empty text', async () => {
    const { app } = build({
      whisperCmd: 'stt',
      runCommand: async () => {
        throw new Error('boom');
      },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/transcribe',
          headers: AUTH,
          payload: audioForm('notes.txt', Buffer.from('x')),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/transcribe',
          headers: AUTH,
          payload: audioForm('dictation.m4a', Buffer.from('x')),
        })
      ).statusCode,
    ).toBe(502);

    const { app: silent } = build({ whisperCmd: 'stt', runCommand: async () => 'Thank you.\n' });
    const res = await silent.inject({
      method: 'POST',
      url: '/sessions/transcribe',
      headers: AUTH,
      payload: audioForm('dictation.m4a', Buffer.from('x')),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: '' });
  });
});
