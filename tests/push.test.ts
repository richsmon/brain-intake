import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { PushTokenStore } from '../src/push/tokens.js';
import {
  APNS_PRODUCTION,
  APNS_SANDBOX,
  ApnsClient,
  makeProviderJwt,
  type ApnsKeyConfig,
  type ApnsTransport,
} from '../src/push/apns.js';
import { PushSender, apnsPayload, formatAttempt, type PushSendAttempt } from '../src/push/sender.js';
import { pushForEvent, sessionDeepLink, wireSessionPush } from '../src/push/wire.js';
import { SessionStore } from '../src/sessions/store.js';
import type { SessionSdk } from '../src/sessions/runner.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'push-'));
}

// A real P-256 keypair — the provider JWT must verify against the public half.
const { privateKey: PRIV, publicKey: PUB } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY: ApnsKeyConfig = {
  privateKey: PRIV.export({ type: 'pkcs8', format: 'pem' }).toString(),
  keyId: 'ABC123DEFG',
  teamId: 'XSP7HN5XM3',
  topic: 'com.richsmon.brain-intake',
};

interface SentRequest {
  endpoint: string;
  path: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function captureTransport(
  respond: (req: SentRequest) => { status: number; body: string; apnsId?: string } = () => ({ status: 200, body: '' }),
) {
  const calls: SentRequest[] = [];
  const transport: ApnsTransport = async (endpoint, path, headers, body) => {
    const req = { endpoint, path, headers, payload: JSON.parse(body) as Record<string, unknown> };
    calls.push(req);
    return respond(req);
  };
  return { calls, transport };
}

describe('PushTokenStore', () => {
  test('registers with dedupe and persists across instances', () => {
    const dir = tmp();
    const store = new PushTokenStore(dir);
    expect(store.register('aaa111')).toBe(true);
    expect(store.register('aaa111')).toBe(false);
    expect(store.register('bbb222')).toBe(true);
    expect(new PushTokenStore(dir).list()).toEqual(['aaa111', 'bbb222']);
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

  // BI-C7 T-22: per-token delivery status lives next to the token, so
  // GET /push/status can answer "did the last push reach this device?".
  test('recordSend persists lastSend next to the token across instances', () => {
    const dir = tmp();
    const store = new PushTokenStore(dir);
    store.register('devicetoken-abcdef12');
    store.recordSend('devicetoken-abcdef12', { ts: '2026-07-22T17:13:00Z', ok: false, status: 403 });
    expect(new PushTokenStore(dir).entries()).toEqual([
      { token: 'devicetoken-abcdef12', lastSend: { ts: '2026-07-22T17:13:00Z', ok: false, status: 403 } },
    ]);
  });

  test('recordSend for an unknown token is a no-op', () => {
    const store = new PushTokenStore(tmp());
    store.register('known');
    store.recordSend('unknown', { ts: '2026-07-22T17:13:00Z', ok: true, status: 200 });
    expect(store.entries()).toEqual([{ token: 'known' }]);
  });

  test('loads the legacy plain-string registry format and upgrades it on write', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'push-tokens.json'), '["legacy-token-1234"]\n', 'utf-8');
    const store = new PushTokenStore(dir);
    expect(store.list()).toEqual(['legacy-token-1234']);
    store.recordSend('legacy-token-1234', { ts: '2026-07-22T19:43:00Z', ok: true, status: 200 });
    expect(new PushTokenStore(dir).entries()).toEqual([
      { token: 'legacy-token-1234', lastSend: { ts: '2026-07-22T19:43:00Z', ok: true, status: 200 } },
    ]);
  });
});

describe('provider JWT (ES256)', () => {
  test('carries kid/iss/iat and verifies against the key', () => {
    const nowMs = 1_753_142_400_000;
    const jwt = makeProviderJwt(KEY, nowMs);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({
      iss: 'XSP7HN5XM3',
      iat: Math.floor(nowMs / 1000),
    });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: PUB, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  test('ApnsClient caches the JWT within 45 min and refreshes after', async () => {
    let now = 1_753_142_400_000;
    const { calls, transport } = captureTransport();
    const client = new ApnsClient(KEY, transport, () => now);
    await client.deliver('tok1', { aps: {} });
    now += 10 * 60_000;
    await client.deliver('tok1', { aps: {} });
    expect(calls[1]!.headers.authorization).toBe(calls[0]!.headers.authorization);
    now += 46 * 60_000;
    await client.deliver('tok1', { aps: {} });
    expect(calls[2]!.headers.authorization).not.toBe(calls[0]!.headers.authorization);
  });
});

describe('ApnsClient.deliver', () => {
  test('POSTs to /3/device/{token} with topic/push-type/priority headers', async () => {
    const { calls, transport } = captureTransport();
    const client = new ApnsClient(KEY, transport);
    await client.deliver('devicetoken123', { aps: { alert: { title: 't' } } });
    expect(calls[0]!.endpoint).toBe(APNS_PRODUCTION);
    expect(calls[0]!.path).toBe('/3/device/devicetoken123');
    expect(calls[0]!.headers).toMatchObject({
      'apns-topic': 'com.richsmon.brain-intake',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    expect(calls[0]!.headers.authorization).toMatch(/^bearer /);
  });

  test('endpoint override targets the sandbox for dev builds', async () => {
    const { calls, transport } = captureTransport();
    const client = new ApnsClient({ ...KEY, endpoint: APNS_SANDBOX }, transport);
    await client.deliver('t', {});
    expect(calls[0]!.endpoint).toBe(APNS_SANDBOX);
  });
});

describe('PushSender', () => {
  test('no APNs client configured ⇒ silent no-op even with registered tokens', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('t1');
    const errors: unknown[] = [];
    const sender = new PushSender({ tokens, onError: (e) => errors.push(e) });
    await sender.send({ title: 't', body: 'b' });
    expect(errors).toHaveLength(0);
  });

  test('zero registered tokens ⇒ no APNs traffic', async () => {
    const { calls, transport } = captureTransport();
    const sender = new PushSender({ tokens: new PushTokenStore(tmp()), client: new ApnsClient(KEY, transport) });
    await sender.send({ title: 't', body: 'b' });
    expect(calls).toHaveLength(0);
  });

  test('delivers the alert payload (deeplink at top level AND under body) per token', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('dev1');
    tokens.register('dev2');
    const { calls, transport } = captureTransport();
    const sender = new PushSender({ tokens, client: new ApnsClient(KEY, transport) });
    await sender.send({ title: 'gotam: done', body: 'Session finished', data: { url: 'brainer:///session/x' } });

    expect(calls.map((c) => c.path)).toEqual(['/3/device/dev1', '/3/device/dev2']);
    expect(calls[0]!.payload).toEqual({
      aps: { alert: { title: 'gotam: done', body: 'Session finished' }, sound: 'default' },
      url: 'brainer:///session/x',
      body: { url: 'brainer:///session/x' },
    });
  });

  test('410 Unregistered and 400 BadDeviceToken evict; other errors only log', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('gone410');
    tokens.register('bad400');
    tokens.register('flaky500');
    tokens.register('alive');
    const errors: unknown[] = [];
    const { transport } = captureTransport((req) => {
      if (req.path.endsWith('gone410')) return { status: 410, body: '{"reason":"Unregistered"}' };
      if (req.path.endsWith('bad400')) return { status: 400, body: '{"reason":"BadDeviceToken"}' };
      if (req.path.endsWith('flaky500')) return { status: 500, body: '{"reason":"InternalServerError"}' };
      return { status: 200, body: '' };
    });
    const sender = new PushSender({ tokens, client: new ApnsClient(KEY, transport), onError: (e) => errors.push(e) });
    await sender.send({ title: 't', body: 'b' });
    expect(tokens.list()).toEqual(['flaky500', 'alive']);
    expect(errors).toHaveLength(1);
  });

  test('a throwing transport never throws out of send()', async () => {
    const tokens = new PushTokenStore(tmp());
    tokens.register('t1');
    const errors: unknown[] = [];
    const boom: ApnsTransport = async () => {
      throw new Error('conn reset');
    };
    const sender = new PushSender({ tokens, client: new ApnsClient(KEY, boom), onError: (e) => errors.push(e) });
    await sender.send({ title: 't', body: 'b' });
    expect(errors).toHaveLength(2); // BI-C7: one per attempt — network errors get a single retry
    expect(tokens.list()).toEqual(['t1']); // transport errors never evict
  });

  test('apnsPayload without data omits the custom keys', () => {
    expect(apnsPayload({ title: 'a', body: 'b' })).toEqual({
      aps: { alert: { title: 'a', body: 'b' }, sound: 'default' },
    });
  });
});

// BI-C7 T-22: every send attempt is observable — the exact hole the T-15 e2e
// exposed (first gate push vanished with zero trace).
describe('PushSender attempt reporting + retry (BI-C7)', () => {
  function harness(respond?: Parameters<typeof captureTransport>[0]) {
    const tokens = new PushTokenStore(tmp());
    tokens.register('devicetoken-abcdef12');
    const attempts: PushSendAttempt[] = [];
    const errors: unknown[] = [];
    const { calls, transport } = captureTransport(respond);
    const sender = new PushSender({
      tokens,
      client: new ApnsClient(KEY, transport),
      onAttempt: (a) => attempts.push(a),
      onError: (e) => errors.push(e),
    });
    return { tokens, attempts, errors, calls, sender };
  }

  test('success: one attempt with token suffix, status and apns-id; lastSend ok', async () => {
    const { tokens, attempts, sender } = harness(() => ({ status: 200, body: '', apnsId: 'A1B2-C3D4' }));
    await sender.send({ title: 't', body: 'b' });
    expect(attempts).toEqual([
      { tokenSuffix: 'abcdef12', attempt: 1, ok: true, status: 200, apnsId: 'A1B2-C3D4' },
    ]);
    expect(tokens.entries()[0]!.lastSend).toMatchObject({ ok: true, status: 200 });
  });

  test('HTTP 4xx: reported, recorded, NOT retried', async () => {
    const { tokens, attempts, errors, calls, sender } = harness(() => ({
      status: 403,
      body: '{"reason":"InvalidProviderToken"}',
    }));
    await sender.send({ title: 't', body: 'b' });
    expect(calls).toHaveLength(1); // no retry on an APNs verdict
    expect(attempts).toEqual([{ tokenSuffix: 'abcdef12', attempt: 1, ok: false, status: 403 }]);
    expect(tokens.entries()[0]!.lastSend).toMatchObject({ ok: false, status: 403 });
    expect(errors).toHaveLength(1);
  });

  test('network-class error: exactly one retry, success on the second attempt', async () => {
    let n = 0;
    const { tokens, attempts, sender } = harness(() => {
      n += 1;
      if (n === 1) throw new Error('socket hang up');
      return { status: 200, body: '' };
    });
    await sender.send({ title: 't', body: 'b' });
    expect(attempts).toEqual([
      { tokenSuffix: 'abcdef12', attempt: 1, ok: false, error: 'Error: socket hang up' },
      { tokenSuffix: 'abcdef12', attempt: 2, ok: true, status: 200 },
    ]);
    expect(tokens.entries()[0]!.lastSend).toMatchObject({ ok: true, status: 200 });
  });

  test('network-class error twice: two attempts, then give up with lastSend recorded', async () => {
    const { tokens, attempts, calls, sender } = harness(() => {
      throw new Error('APNs request timed out after 10000ms');
    });
    await sender.send({ title: 't', body: 'b' });
    expect(calls).toHaveLength(2); // single retry, never more
    expect(attempts.map((a) => a.ok)).toEqual([false, false]);
    expect(tokens.entries()[0]!.lastSend).toMatchObject({
      ok: false,
      error: 'Error: APNs request timed out after 10000ms',
    });
  });

  test('410 Unregistered evicts on the spot — no retry, no lastSend for a dead token', async () => {
    const { tokens, calls, sender } = harness(() => ({ status: 410, body: '{"reason":"Unregistered"}' }));
    await sender.send({ title: 't', body: 'b' });
    expect(calls).toHaveLength(1);
    expect(tokens.entries()).toEqual([]);
  });
});

describe('formatAttempt', () => {
  test('one concise line: suffix, attempt, outcome, status, apns-id', () => {
    expect(formatAttempt({ tokenSuffix: '98b1ad2d', attempt: 1, ok: true, status: 200, apnsId: 'AAA-BBB' })).toBe(
      '[push] …98b1ad2d attempt 1 ok status=200 apns-id=AAA-BBB',
    );
    expect(
      formatAttempt({ tokenSuffix: '98b1ad2d', attempt: 2, ok: false, error: 'Error: APNs request timed out after 10000ms' }),
    ).toBe('[push] …98b1ad2d attempt 2 FAIL Error: APNs request timed out after 10000ms');
    expect(formatAttempt({ tokenSuffix: '98b1ad2d', attempt: 1, ok: false, status: 403 })).toBe(
      '[push] …98b1ad2d attempt 1 FAIL status=403',
    );
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
    const { calls, transport } = captureTransport();
    wireSessionPush({ store, sender: new PushSender({ tokens, client: new ApnsClient(KEY, transport) }) });

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
    expect((calls[0]!.payload.aps as { alert: { title: string } }).alert.title).toBe('gotam: approval needed');
    expect(calls[0]!.payload.url).toBe(`brainer:///session/${id}`);
    expect((calls[1]!.payload.aps as { alert: { title: string } }).alert.title).toBe('gotam: done');
  });
});

describe('push over the full server (BI-C3 direct APNs wiring)', () => {
  function gatingSdk(): SessionSdk {
    return ({ options }) => {
      const iter = (async function* () {
        await options.canUseTool('Edit', { file_path: 'src/a.ts' }, {});
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'edited' }] } };
        yield { type: 'result', subtype: 'success' };
      })();
      return { [Symbol.asyncIterator]: () => iter };
    };
  }

  test('register route guards + dedupes; a gated session pushes on the gate and on done', async () => {
    const { calls, transport } = captureTransport();
    const app = buildServer({
      brainRoot: tmp(),
      sessions: {
        sessionsDir: tmp(),
        repoAllowlist: { gotam: tmp() },
        bashAllowlist: ['git status'],
        approvalTimeoutMin: 30,
        token: 'tok',
        models: [{ id: 'claude-sonnet-5', label: 'Sonnet' }],
        efforts: ['high'],
        sdk: gatingSdk(),
        apns: KEY,
        apnsTransport: transport,
      },
    });
    const auth = { authorization: 'Bearer tok' };

    expect(
      (await app.inject({ method: 'POST', url: '/push/register', payload: { token: 'devtok1' } })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/push/register', headers: auth, payload: {} })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/push/register', headers: auth, payload: { token: 'devtok1' } }))
        .statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url: '/push/register', headers: auth, payload: { token: 'devtok1' } }))
        .statusCode,
    ).toBe(200);

    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth,
      payload: { repo: 'gotam', prompt: 'fix login', permissionMode: 'gated' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.path).toBe('/3/device/devtok1');
    expect(calls[0]!.payload).toMatchObject({
      aps: { alert: { title: 'gotam: approval needed', body: 'Edit · src/a.ts' } },
      url: `brainer:///session/${id}`,
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
    expect(calls[1]!.payload).toMatchObject({
      aps: { alert: { title: 'gotam: done' } },
      url: `brainer:///session/${id}`,
    });
  });

  // BI-C7 T-22: the attempt line goes through pushLog — console-backed in
  // production, so it lands in the launchd log file even though the Fastify
  // request logger is disabled there (the T-15 zero-trace hole).
  test('every send attempt lands in pushLog and GET /push/status, success or failure', async () => {
    const lines: string[] = [];
    const { transport } = captureTransport(() => ({
      status: 403,
      body: '{"reason":"InvalidProviderToken"}',
    }));
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
        sdk: gatingSdk(),
        apns: KEY,
        apnsTransport: transport,
        pushLog: (line) => lines.push(line),
      },
    });
    const auth = { authorization: 'Bearer tok' };
    await app.inject({
      method: 'POST',
      url: '/push/register',
      headers: auth,
      payload: { token: 'devicetoken-abcdef12' },
    });

    expect((await app.inject({ method: 'GET', url: '/push/status' })).statusCode).toBe(401);
    let status = await app.inject({ method: 'GET', url: '/push/status', headers: auth });
    expect(status.json()).toEqual({ configured: true, tokens: [{ suffix: 'abcdef12' }] });

    await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth,
      payload: { repo: 'gotam', prompt: 'fix login', permissionMode: 'gated' },
    });
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    expect(lines[0]).toContain('…abcdef12');
    expect(lines[0]).toContain('FAIL status=403');

    status = await app.inject({ method: 'GET', url: '/push/status', headers: auth });
    expect(status.json()).toMatchObject({
      configured: true,
      tokens: [{ suffix: 'abcdef12', lastSend: { ok: false, status: 403 } }],
    });
  });

  test('no APNs key configured ⇒ registration still works, session runs to done, zero APNs traffic', async () => {
    const { calls, transport } = captureTransport();
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
        apnsTransport: transport, // seam present, but no key ⇒ no client ⇒ no-op
      },
    });
    const auth = { authorization: 'Bearer tok' };
    expect(
      (await app.inject({ method: 'POST', url: '/push/register', headers: auth, payload: { token: 'devtok' } }))
        .statusCode,
    ).toBe(201);
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

    // BI-C7: /push/status says so instead of pretending delivery works.
    const status = await app.inject({ method: 'GET', url: '/push/status', headers: auth });
    expect(status.json()).toMatchObject({ configured: false });
  });
});
