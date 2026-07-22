// BI-C8: local usage aggregation over the session JSONLs in sessionsDir.
// Honest subset of the "gauges" ask that needs no external API: totals of
// tokens + total_cost_usd across OUR OWN runs — nothing here reflects
// subscription limits. Session files are day-prefixed (`YYYY-MM-DD-*.jsonl`),
// so period filtering is filename-based and only files inside a window are
// ever read. Usage is session-cumulative per result event, so the LAST result
// per file is that session's totals — same rule the store's listSessions()
// applies since BI-C5.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toUsage, type SessionEvent, type SessionUsage } from './store.js';

export interface UsagePeriodTotals extends SessionUsage {
  /** Sessions that produced at least one result event in the period. */
  runs: number;
  total_cost_usd: number;
}

export interface UsageSummary {
  today: UsagePeriodTotals;
  last7d: UsagePeriodTotals;
  thisMonth: UsagePeriodTotals;
}

/** Session logs only — skips push-tokens.json and anything else in the dir. */
const SESSION_FILE = /^(\d{4}-\d{2}-\d{2})-.+\.jsonl$/;

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyTotals(): UsagePeriodTotals {
  return {
    runs: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
  };
}

/** UTC day, matching the store's day-prefixed session ids (utcNow). */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface RunTotals {
  usage: SessionUsage | null;
  costUsd: number | null;
}

/** The last result event's usage/cost, or null when the file has no result. */
function lastResultTotals(path: string): RunTotals | null {
  let last: SessionEvent | null = null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(trimmed) as SessionEvent;
    } catch {
      continue;
    }
    if (parsed.event === 'result') last = parsed;
  }
  if (last === null) return null;
  return {
    usage: toUsage(last.usage),
    costUsd: typeof last.total_cost_usd === 'number' ? last.total_cost_usd : null,
  };
}

function add(totals: UsagePeriodTotals, run: RunTotals): void {
  totals.runs += 1;
  if (run.usage !== null) {
    totals.input_tokens += run.usage.input_tokens;
    totals.output_tokens += run.usage.output_tokens;
    totals.cache_creation_input_tokens += run.usage.cache_creation_input_tokens;
    totals.cache_read_input_tokens += run.usage.cache_read_input_tokens;
  }
  if (run.costUsd !== null) totals.total_cost_usd += run.costUsd;
}

/** Scan sessionsDir and total the periods. `now` is a seam; UTC throughout. */
export function computeUsageSummary(dir: string, now: Date = new Date()): UsageSummary {
  const today = utcDay(now);
  const month = today.slice(0, 7);
  // Rolling window: today plus the six previous UTC days.
  const weekFloor = utcDay(new Date(now.getTime() - 6 * DAY_MS));
  const summary: UsageSummary = { today: emptyTotals(), last7d: emptyTotals(), thisMonth: emptyTotals() };

  for (const name of readdirSync(dir)) {
    const m = SESSION_FILE.exec(name);
    if (m === null) continue;
    const day = m[1]!;
    if (day > today) continue; // clock skew — never count the future
    const inLast7d = day >= weekFloor;
    const inMonth = day.slice(0, 7) === month;
    if (!inLast7d && !inMonth) continue;
    const run = lastResultTotals(join(dir, name));
    if (run === null) continue;
    if (day === today) add(summary.today, run);
    if (inLast7d) add(summary.last7d, run);
    if (inMonth) add(summary.thisMonth, run);
  }
  return summary;
}

/**
 * Cached summarizer for the route: the app polls, the scan re-reads every
 * relevant JSONL — a short TTL keeps the endpoint cheap without ever being
 * meaningfully stale (a finished run shows up within `ttlMs`).
 */
export function makeUsageSummary(
  dir: string,
  opts: { ttlMs?: number; now?: () => Date } = {},
): () => UsageSummary {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? ((): Date => new Date());
  let cached: { at: number; value: UsageSummary } | null = null;
  return (): UsageSummary => {
    const at = now().getTime();
    if (cached !== null && at - cached.at < ttlMs) return cached.value;
    const value = computeUsageSummary(dir, new Date(at));
    cached = { at, value };
    return value;
  };
}
