// BI-C2: typed client for the server's coding-sessions API (src/sessions/*).
// Contract mirror of the server routes — field names must never drift.
//
// Mobile POLLS `GET /sessions/:id/events.json?offset=` instead of consuming the
// SSE stream: RN has no native EventSource and the C1 offset-replay contract
// makes polling loss-free. Poll only while a session screen is focused, stop on
// a terminal state.

import { ApiError, MIME_BY_EXT } from "./api";

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

/**
 * BI-C8: per-period totals from `GET /usage/summary`. Local runs through the
 * mini only — NOT subscription limits. Token fields keep the SessionUsage
 * snake_case shape so nothing along the chain ever re-maps.
 */
export interface UsagePeriodTotals extends SessionUsage {
  runs: number;
  total_cost_usd: number;
}

export interface UsageSummary {
  today: UsagePeriodTotals;
  last7d: UsagePeriodTotals;
  thisMonth: UsagePeriodTotals;
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

// MC-R4: structured review findings — mirror of the server's findings contract
// (src/sessions/findings.ts there). The server parses the reviewer's fenced
// findings-json block and serves the result; the app re-validates defensively
// because the payload ultimately originates from model output.

export type ReviewVerdict = "approve" | "request-changes" | "comment";
export type FindingSeverity = "high" | "medium" | "low";

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["high", "medium", "low"];

export interface ReviewFinding {
  severity: FindingSeverity;
  file?: string;
  line?: number;
  title: string;
  detail: string;
}

export interface ReviewFindings {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}

const VERDICTS = new Set<string>(["approve", "request-changes", "comment"] satisfies ReviewVerdict[]);
const SEVERITIES = new Set<string>(FINDING_SEVERITIES);

/** MC-R4: read a `findings` object off a served result event, defensively. */
export function parseFindingsPayload(v: unknown): ReviewFindings | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.verdict !== "string" || !VERDICTS.has(obj.verdict)) return null;
  if (!Array.isArray(obj.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const entry of obj.findings) {
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) continue;
    if (typeof f.title !== "string" || f.title.trim() === "") continue;
    findings.push({
      severity: f.severity as FindingSeverity,
      title: f.title,
      detail: typeof f.detail === "string" ? f.detail : "",
      ...(typeof f.file === "string" && f.file !== "" ? { file: f.file } : {}),
      ...(typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 ? { line: f.line } : {}),
    });
  }
  return { verdict: obj.verdict as ReviewVerdict, findings };
}

/**
 * MC-R4: drop the fenced findings-json tail from a summary shown to the human —
 * the structured section renders it. Only called once findings actually parsed;
 * an unparseable block stays visible as raw text (better weird than hidden).
 */
export function stripFindingsBlock(text: string): string {
  return text.replace(/```findings-json\s*[\s\S]*?```/g, "").trim();
}

// MC-R6: a full review's brief demands a stable `Brain PR: <url>` line in the
// final summary — the link to the review-doc PR the founder merges. Model
// output is untrusted, so both helpers parse defensively.

const BRAIN_PR_LINE = /^\s*Brain PR:\s*<?(https:\/\/github\.com\/[^\s>]+)>?\s*$/im;

/** First `Brain PR:` line's URL, or null when the summary has no usable one. */
export function parseBrainPrUrl(text: string): string | null {
  const match = BRAIN_PR_LINE.exec(text);
  if (!match) return null;
  // Trailing punctuation is prose, not URL.
  const url = match[1]!.replace(/[).,;\]]+$/, "");
  return url.length > "https://github.com/".length ? url : null;
}

/**
 * Drop the `Brain PR:` line from a summary shown to the human — the done
 * card's dedicated link renders it. Only called once the URL actually parsed;
 * an unparseable line stays visible as raw text (better weird than hidden).
 */
export function stripBrainPrLine(text: string): string {
  return text.replace(BRAIN_PR_LINE, "").trim();
}

/** MC-R4: per-severity counts as `/reviews/prs` serves them on lastReview. */
export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

export interface LastReviewFindings {
  verdict: ReviewVerdict;
  counts: SeverityCounts;
  total: number;
}

/** MC-R3: the most recent review session already launched against a PR. */
export interface ReviewLastReview {
  sessionId: string;
  ts: string;
  state: SessionState;
  outcome?: "success" | "error";
  /** MC-R4: verdict + counts once the review produced a parseable findings
   * block; null when it didn't; absent while the session is still running. */
  findings?: LastReviewFindings | null;
}

/** MC-R1: one open PR in the review surface's list (GET /reviews/prs).
 * MC-R2: the list spans the team org and the founder's personal repos, so
 * each row carries `owner`; `repo` stays the short name.
 * MC-R3: `lastReview` links the newest review session for the PR — null when
 * none; optional so pre-MC-R3 servers still parse. */
export interface ReviewPr {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  lastReview?: ReviewLastReview | null;
  /** MC-R6: true on org rows — launching runs the FULL flow (worktree, review
   * doc as a brain PR, verdict-conditional PR feedback) instead of the
   * read-only quick look. Optional so pre-MC-R6 servers parse as quick look. */
  fullReview?: boolean;
}

/** MC-R3: "reviewed 2h ago · done" — the PR row's memory line. MC-R4: once
 * structured findings exist, the verdict replaces the bare state and the
 * finding count rides along — "reviewed 2h ago · request-changes · 3 findings". */
export function formatReviewedLine(last: ReviewLastReview, now: Date = new Date()): string {
  const f = last.findings;
  if (f !== undefined && f !== null) {
    const count = f.total === 1 ? "1 finding" : `${f.total} findings`;
    return `reviewed ${formatAge(last.ts, now)} ago · ${f.verdict}${f.total > 0 ? ` · ${count}` : ""}`;
  }
  const label = last.state === "waiting-approval" ? "waiting" : last.state;
  return `reviewed ${formatAge(last.ts, now)} ago · ${label}`;
}

/** MC-R1: POST /reviews — the server launches a review as a coding session.
 * MC-R2: `owner` picks the checkout root server-side (org vs personal). */
export interface LaunchReviewInput {
  owner: string;
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
// BI-C6: dictation clips ride a multipart upload AND wait for host-side
// whisper — same reasoning as the capture flow's upload timeout.
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Audio extensions the dictation flow can produce (expo-audio records m4a). */
export type DictationExt = "m4a" | "mp3" | "wav";

export function makeSessionsApi(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(
    path: string,
    init: Omit<RequestInit, "signal"> = {},
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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

    // BI-C8: local-runs usage totals for the Coding tab card.
    usageSummary(): Promise<UsageSummary> {
      return request<UsageSummary>("/usage/summary");
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

    // BI-C6: prompt dictation — audio up, transcript back, nothing stored.
    // 503 means WHISPER_CMD is unset on the host; callers fall back to typing.
    transcribe(input: { uri: string; name: string; ext: DictationExt }): Promise<{ text: string }> {
      const form = new FormData();
      // React Native FormData file part: {uri, name, type} object.
      form.append("file", {
        uri: input.uri,
        name: input.name,
        type: MIME_BY_EXT[input.ext],
      } as unknown as Blob);
      return request<{ text: string }>(
        "/sessions/transcribe",
        { method: "POST", body: form },
        TRANSCRIBE_TIMEOUT_MS,
      );
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
