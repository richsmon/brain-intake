// BI-C8: local usage aggregation over sessionsDir JSONLs — filename-based
// period filtering, last-result-per-file totals, short-TTL cache.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { computeUsageSummary, makeUsageSummary } from '../src/sessions/usage.js';

const NOW = new Date('2026-07-22T12:00:00Z');

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'usage-'));
}

function writeSession(d: string, name: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(join(d, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 40,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 1000,
};

function resultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { event: 'result', outcome: 'success', usage: USAGE, total_cost_usd: 0.5, ...overrides };
}

describe('computeUsageSummary', () => {
  test('buckets runs into today / last 7 days / this month by filename date', () => {
    const d = dir();
    writeSession(d, '2026-07-22-aaaa1111.jsonl', [{ event: 'status', status: 'created' }, resultEvent()]);
    writeSession(d, '2026-07-18-bbbb2222.jsonl', [{ event: 'status', status: 'created' }, resultEvent()]);
    writeSession(d, '2026-07-02-cccc3333.jsonl', [{ event: 'status', status: 'created' }, resultEvent()]);

    const s = computeUsageSummary(d, NOW);
    expect(s.today).toMatchObject({ runs: 1, input_tokens: 100, output_tokens: 40, total_cost_usd: 0.5 });
    // 2026-07-16 is the 7-day floor: today + the six previous days.
    expect(s.last7d).toMatchObject({ runs: 2, input_tokens: 200, total_cost_usd: 1 });
    expect(s.thisMonth).toMatchObject({
      runs: 3,
      input_tokens: 300,
      output_tokens: 120,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 3000,
      total_cost_usd: 1.5,
    });
  });

  test('last 7 days reaches into the previous month; this month does not', () => {
    const d = dir();
    writeSession(d, '2026-06-30-aaaa1111.jsonl', [resultEvent()]);
    const s = computeUsageSummary(d, new Date('2026-07-03T08:00:00Z'));
    expect(s.last7d.runs).toBe(1);
    expect(s.thisMonth.runs).toBe(0);
    expect(s.today.runs).toBe(0);
  });

  test('multi-result sessions count once with the LAST result — usage is session-cumulative (BI-C5 rule)', () => {
    const d = dir();
    writeSession(d, '2026-07-22-aaaa1111.jsonl', [
      { event: 'status', status: 'created' },
      resultEvent({ usage: { ...USAGE, input_tokens: 100 }, total_cost_usd: 0.2 }),
      { event: 'chat', text: 'follow-up' },
      resultEvent({ usage: { ...USAGE, input_tokens: 250 }, total_cost_usd: 0.7 }),
    ]);
    const s = computeUsageSummary(d, NOW);
    expect(s.today.runs).toBe(1);
    expect(s.today.input_tokens).toBe(250);
    expect(s.today.total_cost_usd).toBe(0.7);
  });

  test('sessions without a result event are not runs; non-session files and junk lines are skipped', () => {
    const d = dir();
    writeSession(d, '2026-07-22-aaaa1111.jsonl', [{ event: 'status', status: 'created' }]);
    writeFileSync(join(d, 'push-tokens.json'), '{"tokens":[]}', 'utf-8');
    writeFileSync(join(d, '2026-07-22-bbbb2222.jsonl'), 'not json\n' + JSON.stringify(resultEvent()) + '\n', 'utf-8');
    const s = computeUsageSummary(d, NOW);
    expect(s.today.runs).toBe(1);
    expect(s.today.input_tokens).toBe(100);
  });

  test('a result without usage still counts as a run and contributes its cost only', () => {
    const d = dir();
    writeSession(d, '2026-07-22-aaaa1111.jsonl', [{ event: 'result', outcome: 'success', total_cost_usd: 0.3 }]);
    const s = computeUsageSummary(d, NOW);
    expect(s.today).toMatchObject({ runs: 1, input_tokens: 0, output_tokens: 0, total_cost_usd: 0.3 });
  });

  test('empty dir yields all-zero periods', () => {
    const s = computeUsageSummary(dir(), NOW);
    for (const period of [s.today, s.last7d, s.thisMonth]) {
      expect(period).toEqual({
        runs: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_cost_usd: 0,
      });
    }
  });
});

describe('makeUsageSummary (cache)', () => {
  test('serves the cached scan inside the TTL and rescans after it expires', () => {
    const d = dir();
    writeSession(d, '2026-07-22-aaaa1111.jsonl', [resultEvent()]);
    let t = NOW.getTime();
    const summary = makeUsageSummary(d, { ttlMs: 30_000, now: () => new Date(t) });

    expect(summary().today.runs).toBe(1);
    // A run landing inside the TTL stays invisible…
    writeSession(d, '2026-07-22-bbbb2222.jsonl', [resultEvent()]);
    t += 29_000;
    expect(summary().today.runs).toBe(1);
    // …and shows up on the first call after expiry.
    t += 2_000;
    expect(summary().today.runs).toBe(2);
  });
});
