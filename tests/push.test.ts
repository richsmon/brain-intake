import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { PushTokenStore } from '../src/push/tokens.js';
import { EXPO_PUSH_URL, PushSender } from '../src/push/sender.js';
import { pushForEvent, sessionDeepLink, wireSessionPush } from '../src/push/wire.js';
import { SessionStore } from '../src/sessions/store.js';
import type { SessionSdk } from '../src/sessions/runner.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'push-'));
}

interface SentBatch {
  url: string;
  messages: Array<{ to: string; title: string; body: string; data?: Record<string, unknown> }>;
}

function captureFetch(response: { ok?: boolean; status?: number; tickets?: unknown[] } = {}) {
  const calls: SentBatch[] = [];
  const impl = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), messages: JSON.parse(String(init?.body)) as SentBatch['messages'] });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => ({ data: response.tickets ?? [] }),
    };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('PushTokenStore', () => {
  test('registers with dedupe and persists across instances', () => {
    const dir = tmp();
    const store = new PushTokenStore(dir);
    expect(store.register('ExponentPushToken[aaa]')).toBe(true);
    expect(store.register('ExponentPushToken[aaa]')).toBe(false);
    expect(store.register('ExponentPushToken[bbb]')).toBe(true);
    expect(new PushTokenStore(dir).list()).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
  });

  test('remove() drops a token; a corrupt registry file starts clean', () => {
    const dir = tmp();
    const store = new PushTokenStore(dir);
    store.register('t1');
    store.register('t2');
    store.remove('t1');
    expect(store.list()).toEqual(['t2']);

    const corruptDir = tmp();
    writeFileSync(join(corruptDir, 'push-tokens.json'), 'not json', 'utf-8');
    expect(new PushTokenStore(corruptDir).list()).toEqual([]);
  });
});

describe('PushSender', () => {
  test('zero registered tokens ⇒ silent no-op, no network call', async () => {
    const { calls, impl } = captureFetch();
    const sender = new PushSender({ tokens: new PushTokenStore(tmp()), fetchImpl: impl });
    await sender.send({ title: 't', body: 'b' });
    expect(calls).toHaveLength(0);
  });

  test('posts one message per token to the Expo push API', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('ExponentPushToken[aaa]');
    tokens.register('ExponentPushToken[bbb]');
    const { calls, impl } = captureFetch();
    const sender = new PushSender({ tokens, fetchImpl: impl });
    await sender.send({ title: 'gotam: done', body: 'Session finished', data: { url: 'brainer:///session/x' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXPO_PUSH_URL);
    expect(calls[0]!.messages).toHaveLength(2);
    expect(calls[0]!.messages[0]).toMatchObject({
      to: 'ExponentPushToken[aaa]',
      title: 'gotam: done',
      body: 'Session finished',
      sound: 'default',
      data: { url: 'brainer:///session/x' },
    });
  });

  test('a throwing fetch or non-ok response never throws — only onError fires', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('t1');
    const errors: unknown[] = [];
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await new PushSender({ tokens, fetchImpl: boom, onError: (e) => errors.push(e) }).send({ title: 't', body: 'b' });
    expect(errors).toHaveLength(1);

    const { impl } = captureFetch({ ok: false, status: 500 });
    await new PushSender({ tokens, fetchImpl: impl, onError: (e) => errors.push(e) }).send({ title: 't', body: 'b' });
    expect(errors).toHaveLength(2);
    expect(tokens.list()).toEqual(['t1']); // still registered — transport errors never evict
  });

  test('a DeviceNotRegistered ticket evicts exactly that token', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('dead');
    tokens.register('alive');
    const { impl } = captureFetch({
      tickets: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }, { status: 'ok' }],
    });
    await new PushSender({ tokens, fetchImpl: impl }).send({ title: 't', body: 'b' });
    expect(tokens.list()).toEqual(['alive']);
  });
});

describe('pushForEvent', () => {
  const meta = { repo: 'gotam', prompt: 'fix the login flow' };
  const url = sessionDeepLink('2026-07-22-abcd1234');

  test('deeplink uses the app scheme with the expo-router session path', () => {
    expect(url).toBe('brainer:///session/2026-07-22-abcd1234');
  });

  test('permission_request → approval push naming repo + tool detail', () => {
    const bash = pushForEvent(
      { event: 'permission_request', requestId: 'r1', toolName: 'Bash', command: 'npm install left-pad' },
      meta,
      url,
    );
    expect(bash).toMatchObject({
      title: 'gotam: approval needed',
      body: 'Bash · npm install left-pad',
      data: { url },
    });

    const edit = pushForEvent(
      { event: 'permission_request', requestId: 'r2', toolName: 'Edit', path: 'src/login.ts' },
      meta,
      url,
    );
    expect(edit?.body).toBe('Edit · src/login.ts');
  });

  test('terminal statuses → one push each naming repo + state; others are silent', () => {
    expect(pushForEvent({ event: 'status', status: 'done' }, meta, url)).toMatchObject({
      title: 'gotam: done',
      body: 'Session finished — fix the login flow',
      data: { url },
    });
    expect(pushForEvent({ event: 'status', status: 'error' }, meta, url)?.title).toBe('gotam: error');
    expect(pushForEvent({ event: 'status', status: 'paused' }, meta, url)?.title).toBe('gotam: paused');

    expect(pushForEvent({ event: 'status', status: 'running' }, meta, url)).toBeNull();
    expect(pushForEvent({ event: 'status', status: 'waiting-approval' }, meta, url)).toBeNull();
    expect(pushForEvent({ event: 'chat_chunk', text: 'hi' }, meta, url)).toBeNull();
    expect(pushForEvent({ event: 'result', outcome: 'success' }, meta, url)).toBeNull();
  });
});

describe('wireSessionPush', () => {
  test('forwards exactly the push-worthy trail events to the sender', async () => {
    const store = new SessionStore(tmp());
    const tokens = new PushTokenStore(tmp());
    tokens.register('t1');
    const { calls, impl } = captureFetch();
    wireSessionPush({ store, sender: new PushSender({ tokens, fetchImpl: impl }) });

    const id = store.createSession({
      repo: 'gotam',
      repoPath: '/x',
      prompt: 'do the thing',
      model: 'claude-sonnet-5',
      permissionMode: 'gated',
    });
    store.appendEvent(id, { event: 'status', status: 'running' });
    store.appendEvent(id, { event: 'chat_chunk', text: 'working' });
    store.appendEvent(id, { event: 'permission_request', requestId: 'r1', toolName: 'Edit', path: 'a.ts' });
    store.appendEvent(id, { event: 'status', status: 'waiting-approval' });
    store.appendEvent(id, { event: 'status', status: 'done' });

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.messages[0]).toMatchObject({
      title: 'gotam: approval needed',
      data: { url: `brainer:///session/${id}` },
    });
    expect(calls[1]!.messages[0]).toMatchObject({
      title: 'gotam: done',
      data: { url: `brainer:///session/${id}` },
    });
  });
});

describe('push over the full server (BI-C3 wiring)', () => {
  test('register route guards + dedupes; a gated session pushes on the gate and on done', async () => {
    const brainRoot = tmp();
    const sessionsDir = tmp();
    const repoPath = tmp();
    const { calls, impl } = captureFetch();

    // Fake Agent SDK: asks permission for an Edit, then finishes successfully.
    const sdk: SessionSdk = ({ options }) => {
      const iter = (async function* () {
        await options.canUseTool('Edit', { file_path: 'src/a.ts' }, {});
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'edited' }] } };
        yield { type: 'result', subtype: 'success' };
      })();
      return { [Symbol.asyncIterator]: () => iter };
    };

    const app = buildServer({
      brainRoot,
      sessions: {
        sessionsDir,
        repoAllowlist: { gotam: repoPath },
        bashAllowlist: ['git status'],
        approvalTimeoutMin: 30,
        token: 'tok',
        models: [{ id: 'claude-sonnet-5', label: 'Sonnet' }],
        efforts: ['high'],
        sdk,
        pushFetch: impl,
      },
    });
    const auth = { authorization: 'Bearer tok' };

    // Guard + dedupe on the registration route.
    expect(
      (await app.inject({ method: 'POST', url: '/push/register', payload: { token: 'ExponentPushToken[x]' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/push/register', headers: auth, payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/push/register',
          headers: auth,
          payload: { token: 'ExponentPushToken[x]' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/push/register',
          headers: auth,
          payload: { token: 'ExponentPushToken[x]' },
        })
      ).statusCode,
    ).toBe(200);

    // Launch a gated session — the Edit gate must push, then done must push.
    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth,
      payload: { repo: 'gotam', prompt: 'fix login', permissionMode: 'gated' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.messages[0]).toMatchObject({
      to: 'ExponentPushToken[x]',
      title: 'gotam: approval needed',
      body: 'Edit · src/a.ts',
      data: { url: `brainer:///session/${id}` },
    });

    const events = await app.inject({ method: 'GET', url: `/sessions/${id}/events.json`, headers: auth });
    const gate = (events.json() as { events: Array<{ event: string; requestId?: string }> }).events.find(
      (e) => e.event === 'permission_request',
    );
    expect(gate?.requestId).toBeTruthy();
    const approved = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/approve`,
      headers: auth,
      payload: { requestId: gate!.requestId },
    });
    expect(approved.statusCode).toBe(200);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.messages[0]).toMatchObject({
      title: 'gotam: done',
      data: { url: `brainer:///session/${id}` },
    });
  });

  test('no registered device ⇒ sessions run to done with zero push traffic', async () => {
    const { calls, impl } = captureFetch();
    const sdk: SessionSdk = () => {
      const iter = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', subtype: 'success' };
      })();
      return { [Symbol.asyncIterator]: () => iter };
    };
    const app = buildServer({
      brainRoot: tmp(),
      sessions: {
        sessionsDir: tmp(),
        repoAllowlist: { gotam: tmp() },
        bashAllowlist: [],
        approvalTimeoutMin: 30,
        token: 'tok',
        models: [{ id: 'claude-sonnet-5', label: 'Sonnet' }],
        efforts: ['high'],
        sdk,
        pushFetch: impl,
      },
    });
    const auth = { authorization: 'Bearer tok' };
    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth,
      payload: { repo: 'gotam', prompt: 'hi' },
    });
    const { id } = created.json() as { id: string };
    await vi.waitFor(async () => {
      const list = await app.inject({ method: 'GET', url: '/sessions', headers: auth });
      expect((list.json() as Array<{ id: string; state: string }>).find((s) => s.id === id)?.state).toBe('done');
    });
    expect(calls).toHaveLength(0);
  });
});
