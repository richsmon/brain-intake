// BI-C1: session runner. Wraps the Claude Agent SDK `query()` behind a thin
// injected adapter (SessionSdk) so tests drive a fake with scripted tool-call
// sequences — no network, no real repos. The runner owns the permission gate:
//
//   gated       → Edit/Write/NotebookEdit + Bash-outside-allowlist block on a
//                 pending-approval promise
//   acceptEdits → only Bash-outside-allowlist blocks
//   auto        → nothing blocks: every tool call is allowed straight through
//                 (no pending promise, no timeout path); the tool_call trail
//                 still lands in the event log
//
// approve()/deny() resolve the pending promise; a pending request older than
// approvalTimeoutMs is auto-denied and the session is PAUSED (never killed).
// Mode flip and follow-up messages feed the running session (streaming input).
import { randomBytes } from 'node:crypto';
import type { SessionEvent, SessionMeta, SessionStore, SessionUsage } from './store.js';

/** Adapter surface the runner needs from the Agent SDK — see sdk.ts for the real binding. */
export interface SessionPermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
}

export type SessionCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { requestId?: string; toolUseID?: string; signal?: AbortSignal },
) => Promise<SessionPermissionResult>;

export interface SessionUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
}

export interface SessionSdkMessage {
  type: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> };
  subtype?: string;
  is_error?: boolean;
  result?: string;
  /** BI-C5: on `result` messages — token usage mirrored from the SDK (snake_case as it sends it). */
  usage?: SessionUsage;
  total_cost_usd?: number;
}

export interface SessionSdkQueryOptions {
  cwd: string;
  model?: string;
  effort?: string | number;
  permissionMode?: string;
  canUseTool: SessionCanUseTool;
  abortController?: AbortController;
}

export interface SessionSdkQuery extends AsyncIterable<SessionSdkMessage> {
  setPermissionMode?(mode: string): Promise<void>;
  setModel?(model?: string): Promise<void>;
  interrupt?(): Promise<unknown>;
}

export type SessionSdk = (params: {
  prompt: string | AsyncIterable<SessionUserMessage>;
  options: SessionSdkQueryOptions;
}) => SessionSdkQuery;

export interface RunnerConfig {
  store: SessionStore;
  sdk: SessionSdk;
  bashAllowlist: string[];
  approvalTimeoutMs: number;
}

export interface StartOptions {
  model?: string;
  effort?: string;
  permissionMode?: SessionPermissionMode;
  /** MC-R6: extra bash-allowlist prefixes for THIS session only (full-review
   * orchestration pins them to one worktree + one PR). Merged on top of the
   * runner-wide allowlist; never leaks into other sessions. */
  extraBashAllowlist?: string[];
}

/** Our permission vocabulary — NOT the SDK's (see sdkPermissionMode below). */
export type SessionPermissionMode = 'gated' | 'acceptEdits' | 'auto';

type Mode = SessionPermissionMode;

/**
 * Map our mode to the SDK's. Deliberately NOT the SDK's `bypassPermissions`
 * (or its unrelated classifier mode also named `auto`) for our `auto`:
 * bypass skips `canUseTool` entirely, which would drop the `tool_call` trail
 * from the event log and needs `allowDangerouslySkipPermissions`. Keeping the
 * SDK on `default` keeps every call flowing through our gate, where `auto`
 * is a plain pass-through.
 */
function sdkPermissionMode(mode: Mode): string {
  return mode === 'acceptEdits' ? 'acceptEdits' : 'default';
}

interface Pending {
  resolve: (r: SessionPermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_based_edit_tool']);

/** True if this tool call must block on human approval under the given mode. */
export function shouldGate(
  toolName: string,
  input: Record<string, unknown>,
  mode: Mode,
  bashAllowlist: string[],
): boolean {
  if (mode === 'auto') return false;
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const allowed = bashAllowlist.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
    return !allowed;
  }
  if (EDIT_TOOLS.has(toolName)) return mode === 'gated';
  return false;
}

class RunController {
  mode: Mode;
  /** MC-R6: per-session allowlist — runner-wide entries plus any session-scoped extension. */
  readonly bashAllowlist: string[];
  readonly pending = new Map<string, Pending>();
  query?: SessionSdkQuery;
  private readonly queue: SessionUserMessage[] = [];
  private readonly waiters: Array<(r: IteratorResult<SessionUserMessage>) => void> = [];
  private closed = false;

  constructor(mode: Mode, initialPrompt: string, bashAllowlist: string[]) {
    this.mode = mode;
    this.bashAllowlist = bashAllowlist;
    this.queue.push({ type: 'user', message: { role: 'user', content: initialPrompt } });
  }

  pushMessage(text: string): void {
    const msg: SessionUserMessage = { type: 'user', message: { role: 'user', content: text } };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.queue.push(msg);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  hasQueuedInput(): boolean {
    return this.queue.length > 0;
  }

  close(): void {
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined as unknown as SessionUserMessage, done: true });
      waiter = this.waiters.shift();
    }
  }

  private next(): Promise<IteratorResult<SessionUserMessage>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as unknown as SessionUserMessage, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  prompt(): AsyncIterable<SessionUserMessage> {
    const next = (): Promise<IteratorResult<SessionUserMessage>> => this.next();
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionUserMessage> {
        return { next };
      },
    };
  }
}

export class SessionRunner {
  private readonly cfg: RunnerConfig;
  private readonly active = new Map<string, RunController>();

  constructor(cfg: RunnerConfig) {
    this.cfg = cfg;
  }

  /** Drive an already-created session to completion. Resolves when the SDK query ends. */
  async run(id: string, meta: SessionMeta, opts: StartOptions = {}): Promise<void> {
    const { store } = this.cfg;
    const mode: Mode = opts.permissionMode ?? (meta.permissionMode as Mode) ?? 'gated';
    const controller = new RunController(mode, meta.prompt, [
      ...this.cfg.bashAllowlist,
      ...(opts.extraBashAllowlist ?? []),
    ]);
    this.active.set(id, controller);
    store.appendEvent(id, { event: 'status', status: 'running' });

    const canUseTool: SessionCanUseTool = (toolName, input, options) =>
      this.gate(id, controller, toolName, input, options);

    try {
      const query = this.cfg.sdk({
        prompt: controller.prompt(),
        options: {
          cwd: meta.repoPath,
          canUseTool,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          permissionMode: sdkPermissionMode(mode),
        },
      });
      controller.query = query;

      let outcome: 'success' | 'error' = 'success';
      let summary = '';
      let usage: SessionUsage | undefined;
      let totalCostUsd: number | undefined;
      for await (const message of query) {
        if (message.type === 'assistant') {
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
              store.appendEvent(id, { event: 'chat_chunk', text: block.text });
            }
          }
        } else if (message.type === 'result') {
          outcome = message.is_error === true || (message.subtype !== undefined && message.subtype !== 'success')
            ? 'error'
            : 'success';
          if (typeof message.result === 'string') summary = message.result;
          // BI-C5: the SDK reports session-cumulative usage/cost on every
          // result — keep the latest, never sum (summing would double-count).
          if (message.usage !== undefined) usage = message.usage;
          if (typeof message.total_cost_usd === 'number') totalCostUsd = message.total_cost_usd;
          // BI-C2: the real SDK (streaming input) keeps the query open for more
          // input after a turn's result. With nothing queued and no gate pending
          // the session is finished — close the input so the query ends and the
          // trail reaches its terminal state. (The C1 fake SDKs ended their own
          // iterators, which masked this.)
          if (!controller.hasQueuedInput() && controller.pending.size === 0) {
            controller.close();
          }
        }
      }

      store.appendEvent(id, {
        event: 'result',
        outcome,
        ...(summary ? { summary } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
      });
      // A gate that timed out already paused the session — leave it paused, never revive to done.
      const paused = store.readEvents(id).some((e) => e.event === 'status' && e.status === 'paused');
      if (!paused) {
        store.appendEvent(id, { event: 'status', status: outcome === 'success' ? 'done' : 'error' });
      }
    } catch (err) {
      store.appendEvent(id, {
        event: 'result',
        outcome: 'error',
        summary: err instanceof Error ? err.message : String(err),
      });
      store.appendEvent(id, { event: 'status', status: 'error' });
    } finally {
      for (const [, p] of controller.pending) clearTimeout(p.timer);
      controller.pending.clear();
      controller.close();
      this.active.delete(id);
    }
  }

  private gate(
    id: string,
    controller: RunController,
    toolName: string,
    input: Record<string, unknown>,
    options: { requestId?: string; toolUseID?: string },
  ): Promise<SessionPermissionResult> {
    const { store } = this.cfg;
    const requestId = options.requestId ?? options.toolUseID ?? randomBytes(6).toString('hex');
    store.appendEvent(id, { event: 'tool_call', requestId, toolName, input });

    if (!shouldGate(toolName, input, controller.mode, controller.bashAllowlist)) {
      return Promise.resolve({ behavior: 'allow' });
    }

    const payload: SessionEvent = { event: 'permission_request', requestId, toolName, input };
    if (toolName === 'Bash' && typeof input.command === 'string') payload.command = input.command;
    const filePath = input.file_path ?? input.path;
    if (typeof filePath === 'string') payload.path = filePath;
    store.appendEvent(id, payload);
    store.appendEvent(id, { event: 'status', status: 'waiting-approval' });

    return new Promise<SessionPermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        controller.pending.delete(requestId);
        store.appendEvent(id, { event: 'permission_resolved', requestId, decision: 'timeout' });
        store.appendEvent(id, { event: 'status', status: 'paused' });
        resolve({ behavior: 'deny', message: 'approval timed out — session paused' });
      }, this.cfg.approvalTimeoutMs);
      controller.pending.set(requestId, { resolve, timer });
    });
  }

  approve(id: string, requestId: string): boolean {
    const controller = this.active.get(id);
    const pending = controller?.pending.get(requestId);
    if (!controller || !pending) return false;
    clearTimeout(pending.timer);
    controller.pending.delete(requestId);
    this.cfg.store.appendEvent(id, { event: 'permission_resolved', requestId, decision: 'approved' });
    this.cfg.store.appendEvent(id, { event: 'status', status: 'running' });
    pending.resolve({ behavior: 'allow' });
    return true;
  }

  deny(id: string, requestId: string, message = 'denied by user'): boolean {
    const controller = this.active.get(id);
    const pending = controller?.pending.get(requestId);
    if (!controller || !pending) return false;
    clearTimeout(pending.timer);
    controller.pending.delete(requestId);
    this.cfg.store.appendEvent(id, { event: 'permission_resolved', requestId, decision: 'denied' });
    this.cfg.store.appendEvent(id, { event: 'status', status: 'running' });
    pending.resolve({ behavior: 'deny', message });
    return true;
  }

  async setMode(id: string, mode: Mode): Promise<boolean> {
    const controller = this.active.get(id);
    if (!controller) return false;
    controller.mode = mode;
    this.cfg.store.appendEvent(id, { event: 'status', status: 'running' });
    this.cfg.store.appendEvent(id, { event: 'mode', mode });
    if (controller.query?.setPermissionMode) {
      await controller.query.setPermissionMode(sdkPermissionMode(mode));
    }
    return true;
  }

  sendMessage(id: string, text: string): boolean {
    const controller = this.active.get(id);
    if (!controller || controller.isClosed) return false;
    this.cfg.store.appendEvent(id, { event: 'user_message', text });
    controller.pushMessage(text);
    return true;
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }
}
