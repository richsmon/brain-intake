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

export type PermissionMode = "gated" | "acceptEdits";

export interface SessionEvent {
  index: number;
  event: string;
  ts?: string;
  [key: string]: unknown;
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
