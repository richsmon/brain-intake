// Loop-report parsing — pure and tolerant. Reports come from the brain repo's
// tools/brain-loop cron (reports/brain-loop/*.md); missing sections read as
// null/0, never throw — the digest must survive format drift.

export interface LoopRunSummary {
  reportId: string;
  mode: string | null;
  openItems: number | null;
  openPrsBefore: number | null;
  selected: number | null;
  questions: number | null;
  claimed: number | null;
  skipped: number | null;
  prsOpened: number;
  errors: number;
}

function countField(text: string, label: RegExp): number | null {
  const m = text.match(label);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function sectionItems(text: string, heading: string): number {
  const start = new RegExp(`^## ${heading}\\s*$`, 'm').exec(text);
  if (!start) return 0;
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(/^## /m);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && !l.startsWith('- (none)')).length;
}

export function parseLoopReport(reportId: string, markdown: string): LoopRunSummary {
  return {
    reportId,
    mode: markdown.match(/\*\*Mode:\*\*\s*(\S+)/)?.[1] ?? null,
    openItems: countField(markdown, /^- open items:\s*(\d+)/m),
    openPrsBefore: countField(markdown, /^- open loop PRs \(before run\):\s*(\d+)/m),
    selected: countField(markdown, /^- selected:\s*(\d+)/m),
    questions: countField(markdown, /^- routed to questions\/ \(needs-human\):\s*(\d+)/m),
    claimed: countField(markdown, /^- claimed:\s*(\d+)/m),
    skipped: countField(markdown, /^- skipped \(claim lost \/ error\):\s*(\d+)/m),
    prsOpened: sectionItems(markdown, 'PRs opened'),
    errors: sectionItems(markdown, 'Errors'),
  };
}
