import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseLoopReport } from '../src/loop-report.js';
import { buildServer } from '../src/server.js';

function tmpBrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  mkdirSync(join(root, 'inbox'));
  return root;
}

const QUIET_RUN = `# brain-loop run — 2026-07-18 — richsmon

**Mode:** live
**Backpressure:** no

## Counts

- open items: 3
- open loop PRs (before run): 0
- selected: 3
- routed to questions/ (needs-human): 0
- claimed: 0
- skipped (claim lost / error): 3

## PRs opened

- (none)

## Errors

- gardener:day-without-session-file: claim lost (branch already pushed)
- dropped-thread:gotam/channel-model: claim lost (branch already pushed)
- dropped-thread:gotam/visual-reskin-bitcoin-citizen: claim lost (branch already pushed)
`;

const BUSY_RUN = `# brain-loop run — 2026-07-19 — richsmon

**Mode:** live
**Backpressure:** no

## Counts

- open items: 5
- open loop PRs (before run): 1
- selected: 4
- routed to questions/ (needs-human): 2
- claimed: 2
- skipped (claim lost / error): 0

## PRs opened

- #31 gardener: prune stale worktrees
- #32 dropped-thread: revive channel-model note

## Errors

- (none)
`;

describe('parseLoopReport', () => {
  test('parses counts, PRs opened, and errors from a real report', () => {
    const s = parseLoopReport('2026-07-18-richsmon.md', QUIET_RUN);
    expect(s).toMatchObject({
      reportId: '2026-07-18-richsmon.md',
      mode: 'live',
      openItems: 3,
      openPrsBefore: 0,
      selected: 3,
      questions: 0,
      skipped: 3,
      prsOpened: 0,
      errors: 3,
    });
  });

  test('counts real PRs-opened entries; (none) markers count as zero', () => {
    const s = parseLoopReport('2026-07-19-richsmon.md', BUSY_RUN);
    expect(s.prsOpened).toBe(2);
    expect(s.errors).toBe(0);
    expect(s.questions).toBe(2);
    expect(s.openPrsBefore).toBe(1);
  });

  test('is tolerant of missing sections — nulls, not throws', () => {
    const s = parseLoopReport('x.md', '# brain-loop run\n\nnothing structured here\n');
    expect(s.reportId).toBe('x.md');
    expect(s.mode).toBeNull();
    expect(s.openItems).toBeNull();
    expect(s.prsOpened).toBe(0);
    expect(s.errors).toBe(0);
  });
});

describe('GET /digest — loop block', () => {
  test('digest carries a parsed summary of the latest loop report', async () => {
    const root = tmpBrain();
    const reports = join(root, 'reports', 'brain-loop');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, '2026-07-18-richsmon.md'), QUIET_RUN);
    writeFileSync(join(reports, '2026-07-19-richsmon.md'), BUSY_RUN);
    writeFileSync(join(reports, 'README.md'), '# not a report');

    const app = buildServer({ brainRoot: root });
    const body = (await app.inject({ method: 'GET', url: '/digest' })).json();

    expect(body.lastReport).toBe('2026-07-19-richsmon.md');
    expect(body.loop).toMatchObject({
      reportId: '2026-07-19-richsmon.md',
      prsOpened: 2,
      questions: 2,
      errors: 0,
    });
  });

  test('no reports dir → loop is null', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const body = (await app.inject({ method: 'GET', url: '/digest' })).json();
    expect(body.loop).toBeNull();
  });
});
