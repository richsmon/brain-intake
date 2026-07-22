// MC-R4: structured review findings. The review brief (src/reviews/prompt.ts)
// requires the reviewer to END its final message with a fenced ```findings-json
// block; this module parses that block out of the stored result summary.
//
// Model output is UNTRUSTED — parsing is defensive throughout: a missing block,
// broken JSON, a wrong verdict or a non-array findings list all yield `null`
// (the payloads carry `findings: null`, never an error). Individual findings
// that don't fit the shape are dropped; optional file/line fields are dropped
// when malformed rather than failing the finding.
//
// Lives in sessions/ (not reviews/) because the parsed findings are a session
// artifact — the store and the events routes surface them — and reviews/
// already imports from sessions/, never the other way around.

export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';
export type FindingSeverity = 'high' | 'medium' | 'low';

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

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

const VERDICTS = new Set<string>(['approve', 'request-changes', 'comment'] satisfies ReviewVerdict[]);
const SEVERITIES = new Set<string>(['high', 'medium', 'low'] satisfies FindingSeverity[]);

/** Fenced block tagged findings-json (global — matchAll walks every block). */
const BLOCK = /```findings-json\s*([\s\S]*?)```/g;

/**
 * Pull structured findings out of a review session's final message. The LAST
 * findings-json block wins (the brief demands it be the last thing in the
 * message, but a model quoting the instructions could emit an earlier one).
 */
export function parseFindings(text: unknown): ReviewFindings | null {
  if (typeof text !== 'string') return null;
  let raw: string | null = null;
  for (const match of text.matchAll(BLOCK)) raw = match[1] ?? null;
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.verdict !== 'string' || !VERDICTS.has(obj.verdict)) return null;
  if (!Array.isArray(obj.findings)) return null;

  const findings: ReviewFinding[] = [];
  for (const entry of obj.findings) {
    if (typeof entry !== 'object' || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.severity !== 'string' || !SEVERITIES.has(f.severity)) continue;
    if (typeof f.title !== 'string' || f.title.trim() === '') continue;
    findings.push({
      severity: f.severity as FindingSeverity,
      title: f.title,
      detail: typeof f.detail === 'string' ? f.detail : '',
      ...(typeof f.file === 'string' && f.file !== '' ? { file: f.file } : {}),
      ...(typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? { line: f.line } : {}),
    });
  }
  return { verdict: obj.verdict as ReviewVerdict, findings };
}

/** Per-severity totals for compact payloads (the PR list's lastReview). */
export function severityCounts(findings: ReviewFinding[]): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
