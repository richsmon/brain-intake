// BI-C1: JSONL-backed session store. One append-only `{id}.jsonl` per session,
// same pattern as the inbox item trail (inbox.ts) — the log is the single
// source of truth; state is derived from the last `status` event, never kept
// in a parallel file. Live consumers (SSE) subscribe per session id.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { utcNow } from '../inbox.js';
import { parseFindings, type ReviewFindings } from './findings.js';

export type SessionEvent = { event: string; ts?: string } & Record<string, unknown>;
export type StoredEvent = SessionEvent & { index: number };

export type SessionState = 'created' | 'running' | 'waiting-approval' | 'paused' | 'done' | 'error';

/** BI-C3: firehose channel for cross-session subscribers (push bridge). */
const ALL_EVENTS = Symbol('all-events');

/** MC-R3: which PR a review session reviews — set by POST /reviews only. */
export interface ReviewRef {
  owner: string;
  repo: string;
  pr: number;
}

export interface SessionMeta {
  repo: string;
  repoPath: string;
  prompt: string;
  model: string;
  permissionMode: string;
  effort?: string;
  /** MC-R3: present on review sessions; plain coding sessions never carry it. */
  review?: ReviewRef;
}

/**
 * BI-C5: token usage mirrored from the Agent SDK result message. Field names
 * stay the SDK's snake_case on purpose — the `result` event, the list payload
 * and the mobile client all carry the same shape, so nothing ever re-maps.
 */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface SessionSummary extends SessionMeta {
  id: string;
  state: SessionState;
  createdAt: string;
  lastEvent: string;
  /** BI-C5: from the session's last `result` event, when the SDK reported usage. */
  usage?: SessionUsage;
  total_cost_usd?: number;
  /** MC-R3: from the session's last `result` event — how the run ended. */
  outcome?: 'success' | 'error';
  /** MC-R4: review sessions with a result only — structured findings parsed
   * lazily from the final message's ```findings-json block; null when the
   * block is missing or malformed (model output is untrusted). */
  findings?: ReviewFindings | null;
}

export class SessionStore {
  readonly dir: string;
  private readonly emitter = new EventEmitter();
  private readonly counts = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
    this.emitter.setMaxListeners(0);
  }

  private file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  createSession(meta: SessionMeta): string {
    const id = `${utcNow().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    const first: SessionEvent = { ts: utcNow(), event: 'status', status: 'created', ...meta };
    writeFileSync(this.file(id), `${JSON.stringify(first)}\n`, 'utf-8');
    this.counts.set(id, 1);
    return id;
  }

  has(id: string): boolean {
    return existsSync(this.file(id));
  }

  appendEvent(id: string, event: SessionEvent): number {
    const stamped = { ts: utcNow(), ...event };
    appendFileSync(this.file(id), `${JSON.stringify(stamped)}\n`, 'utf-8');
    const index = this.counts.get(id) ?? this.readEvents(id).length - 1;
    this.counts.set(id, index + 1);
    const stored: StoredEvent = { ...stamped, index };
    this.emitter.emit(id, stored);
    this.emitter.emit(ALL_EVENTS, id, stored);
    return index;
  }

  readEvents(id: string, fromOffset = 0): StoredEvent[] {
    const p = this.file(id);
    if (!existsSync(p)) return [];
    const out: StoredEvent[] = [];
    let index = 0;
    for (const raw of readFileSync(p, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: SessionEvent;
      try {
        parsed = JSON.parse(line) as SessionEvent;
      } catch {
        continue;
      }
      if (index >= fromOffset) out.push({ ...parsed, index });
      index += 1;
    }
    this.counts.set(id, index);
    return out;
  }

  listSessions(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const name of readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort()) {
      const id = name.slice(0, -'.jsonl'.length);
      const events = this.readEvents(id);
      if (events.length === 0) continue;
      const created = events[0]!;
      // BI-C5: the SDK reports session-cumulative usage on every result — the
      // last result event is the session's totals.
      const lastResult = events.filter((e) => e.event === 'result').at(-1);
      const usage = lastResult !== undefined ? toUsage(lastResult.usage) : null;
      // MC-R3: pre-MC-R3 review sessions never wrote a review ref — they list
      // as plain sessions and simply stay unlinked from the PR list.
      const review = toReview(created.review);
      out.push({
        id,
        state: sessionState(events),
        createdAt: typeof created.ts === 'string' ? created.ts : '',
        lastEvent: events[events.length - 1]!.event,
        repo: str(created.repo),
        repoPath: str(created.repoPath),
        prompt: str(created.prompt),
        model: str(created.model),
        permissionMode: str(created.permissionMode),
        ...(typeof created.effort === 'string' ? { effort: created.effort } : {}),
        ...(review !== null ? { review } : {}),
        // MC-R4: derived lazily from the stored summary on every list — the
        // JSONL stays the raw truth, nothing re-parses into a parallel file.
        ...(review !== null && lastResult !== undefined ? { findings: parseFindings(lastResult.summary) } : {}),
        ...(usage !== null ? { usage } : {}),
        ...(lastResult !== undefined && typeof lastResult.total_cost_usd === 'number'
          ? { total_cost_usd: lastResult.total_cost_usd }
          : {}),
        ...(lastResult !== undefined && (lastResult.outcome === 'success' || lastResult.outcome === 'error')
          ? { outcome: lastResult.outcome }
          : {}),
      });
    }
    return out;
  }

  subscribe(id: string, listener: (event: StoredEvent) => void): () => void {
    this.emitter.on(id, listener);
    return () => this.emitter.off(id, listener);
  }

  /** BI-C3: every appended event across all sessions — feeds the push bridge. */
  subscribeAll(listener: (id: string, event: StoredEvent) => void): () => void {
    this.emitter.on(ALL_EVENTS, listener);
    return () => this.emitter.off(ALL_EVENTS, listener);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** MC-R3: read a review ref off a stored created event, defensively. */
function toReview(v: unknown): ReviewRef | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.owner !== 'string' || typeof r.repo !== 'string' || typeof r.pr !== 'number') return null;
  return { owner: r.owner, repo: r.repo, pr: r.pr };
}

/** BI-C5: read a `usage` object off a stored result event, defensively.
 * Exported since BI-C8 — the usage aggregation applies the same rule. */
export function toUsage(v: unknown): SessionUsage | null {
  if (typeof v !== 'object' || v === null) return null;
  const u = v as Record<string, unknown>;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
  };
}

/** Derive the session's state from its trail — the last `status` event wins. */
export function sessionState(events: SessionEvent[]): SessionState {
  let state: SessionState = 'created';
  for (const e of events) {
    if (e.event === 'status' && typeof e.status === 'string') state = e.status as SessionState;
  }
  return state;
}
