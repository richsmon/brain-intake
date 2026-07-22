// BI-C2: typed client for the server's coding-sessions API (src/sessions/*).
// Contract mirror of the server routes — field names must never drift.
//
// Mobile POLLS `GET /sessions/:id/events.json?offset=` instead of consuming the
// SSE stream: RN has no native EventSource and the C1 offset-replay contract
// makes polling loss-free. Poll only while a session screen is focused, stop on
// a terminal state.

import { ApiError } from "./api";

export type SessionState =
  | "created"
  | "running"
  | "waiting-approval"
  | "paused"
  | "done"
  | "error";

// BI-C4: `auto` = no permission gates at all — the server allows every tool call.
export type PermissionMode = "gated" | "acceptEdits" | "auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["gated", "acceptEdits", "auto"];

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "gated":
      return "gated (approve edits)";
    case "acceptEdits":
      return "acceptEdits";
    case "auto":
      return "auto (no gates)";
  }
}

export interface SessionEvent {
  index: number;
  event: string;
  ts?: string;
  [key: string]: unknown;
}

/**
 * BI-C5: per-run token usage mirrored from the server's `result` event, which
 * mirrors the Agent SDK result message — snake_case field names on purpose so
 * nothing along the chain ever re-maps.
 */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface SessionSummary {
  id: string;
  state: SessionState;
  createdAt: string;
  lastEvent: string;
  repo: string;
  repoPath: string;
  prompt: string;
  model: string;
  permissionMode: string;
  effort?: string;
  /** BI-C5: from the session's last result event, when the SDK reported usage. */
  usage?: SessionUsage;
  total_cost_usd?: number;
}

export interface EventsPage {
  events: SessionEvent[];
  nextOffset: number;
  state: SessionState;
}

export interface SessionModel {
  id: string;
  label: string;
}

export interface SessionsMeta {
  repos: string[];
  models: SessionModel[];
  efforts: string[];
}

export interface CreateSessionInput {
  repo: string;
  prompt: string;
  model: string;
  effort?: string;
  permissionMode?: PermissionMode;
}

/** MC-R1: one open PR in the review surface's org list (GET /reviews/prs). */
export interface ReviewPr {
  repo: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  updatedAt: string;
  additions: number;
  deletions: number;
}

/** MC-R1: POST /reviews — the server launches a review as a coding session. */
export interface LaunchReviewInput {
  repo: string;
  pr: number;
  model: string;
  effort?: string;
}

/** Compact age for PR rows: "5m", "3h", "2d". Clamps future/invalid to "0m". */
export function formatAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  const mins = Number.isNaN(then) ? 0 : Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (24 * 60))}d`;
}

/** BI-C5: read a `usage` object off a raw result event, defensively. */
export function parseUsage(v: unknown): SessionUsage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;
  const num = (x: unknown): number => (typeof x === "number" ? x : 0);
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
  };
}

/** Compact token count: 950 → "950", 12 345 → "12.3k", 2 400 000 → "2.4M". */
export function formatTokenCount(n: number): string {
  const compact = (v: number): string => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${compact(n / 1000)}k`;
  return `${compact(n / 1_000_000)}M`;
}

/** "$0.43" for typical runs, three decimals below 10¢ so small runs don't read as free. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}

/**
 * One-line usage summary for the done card, e.g.
 * "1.2k in · 340 out · 88k cached · $0.43". Null when there is nothing to show.
 */
export function formatUsageLine(usage?: SessionUsage, totalCostUsd?: number): string | null {
  const parts: string[] = [];
  if (usage) {
    parts.push(`${formatTokenCount(usage.input_tokens)} in`, `${formatTokenCount(usage.output_tokens)} out`);
    if (usage.cache_read_input_tokens > 0) parts.push(`${formatTokenCount(usage.cache_read_input_tokens)} cached`);
  }
  if (typeof totalCostUsd === "number") parts.push(formatCost(totalCostUsd));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const POLL_INTERVAL_MS = 1500;

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(["done", "error", "paused"]);

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.has(state);
}

const TIMEOUT_MS = 5000;

export function makeSessionsApi(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: Omit<RequestInit, "signal"> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch {
      throw new ApiError("unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new ApiError("http", res.status);
    }
    return (await res.json()) as T;
  }

  function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return {
    create(input: CreateSessionInput): Promise<{ id: string }> {
      return post<{ id: string }>("/sessions", { ...input });
    },

    list(): Promise<SessionSummary[]> {
      return request<SessionSummary[]>("/sessions");
    },

    meta(): Promise<SessionsMeta> {
      return request<SessionsMeta>("/sessions/meta");
    },

    events(id: string, offset = 0): Promise<EventsPage> {
      return request<EventsPage>(`/sessions/${encodeURIComponent(id)}/events.json?offset=${offset}`);
    },

    approve(id: string, requestId: string): Promise<{ ok: boolean }> {
      return post<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/approve`, { requestId });
    },

    deny(id: string, requestId: string, message?: string): Promise<{ ok: boolean }> {
      return post<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/deny`, {
        requestId,
        ...(message !== undefined ? { message } : {}),
      });
    },

    setMode(id: string, mode: PermissionMode): Promise<{ ok: boolean }> {
      return post<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/mode`, { mode });
    },

    sendMessage(id: string, text: string): Promise<{ ok: boolean }> {
      return post<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/message`, { text });
    },

    // MC-R1: review surface — same bearer token, same server, so it rides this client.
    reviewPrs(): Promise<ReviewPr[]> {
      return request<ReviewPr[]>("/reviews/prs");
    },

    launchReview(input: LaunchReviewInput): Promise<{ sessionId: string }> {
      return post<{ sessionId: string }>("/reviews", { ...input });
    },
  };
}

export type SessionsApi = ReturnType<typeof makeSessionsApi>;

/**
 * Poll a session's event log. Fetches immediately, then every `intervalMs`
 * while the screen using it stays mounted. Stops itself on a terminal state;
 * transient fetch failures keep the loop alive (drops are cosmetic — the
 * offset contract replays anything missed). Returns a stop function.
 */
export function startEventsPoll(
  api: Pick<SessionsApi, "events">,
  id: string,
  onPage: (page: EventsPage) => void,
  opts: { fromOffset?: number; intervalMs?: number } = {},
): () => void {
  let offset = opts.fromOffset ?? 0;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    let page: EventsPage | null = null;
    try {
      page = await api.events(id, offset);
    } catch {
      // Offline / transient — keep polling; the offset replays the gap.
    }
    if (stopped) return;
    if (page) {
      offset = page.nextOffset;
      onPage(page);
      if (isTerminal(page.state)) return;
    }
    timer = setTimeout(() => void tick(), intervalMs);
  }

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
