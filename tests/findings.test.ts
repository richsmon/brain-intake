// MC-R4: the findings-json parser treats the reviewer's final message as
// untrusted — every malformed shape lands on null (or a dropped entry), never
// a throw.
import { describe, expect, test } from 'vitest';
import { parseFindings, severityCounts } from '../src/sessions/findings.js';

const GOOD_BLOCK = [
  '## Verdict',
  'Request changes — the retry loop can spin forever.',
  '',
  '```findings-json',
  JSON.stringify({
    verdict: 'request-changes',
    findings: [
      { severity: 'high', file: 'src/retry.ts', line: 42, title: 'Unbounded retry loop', detail: 'Cap attempts at 5.' },
      { severity: 'low', title: 'Typo in comment', detail: 'recieve → receive' },
    ],
  }),
  '```',
].join('\n');

describe('parseFindings', () => {
  test('parses the fenced block out of a prose-wrapped final message', () => {
    expect(parseFindings(GOOD_BLOCK)).toEqual({
      verdict: 'request-changes',
      findings: [
        { severity: 'high', file: 'src/retry.ts', line: 42, title: 'Unbounded retry loop', detail: 'Cap attempts at 5.' },
        { severity: 'low', title: 'Typo in comment', detail: 'recieve → receive' },
      ],
    });
  });

  test('a clean approve with an empty findings list parses', () => {
    const text = 'All good.\n\n```findings-json\n{"verdict": "approve", "findings": []}\n```';
    expect(parseFindings(text)).toEqual({ verdict: 'approve', findings: [] });
  });

  test('the LAST block wins when the message quotes the instructions first', () => {
    const text = [
      'The brief asked for:',
      '```findings-json\n{"verdict": "approve" | "request-changes", "findings": []}\n```',
      'Here it is:',
      '```findings-json\n{"verdict": "comment", "findings": []}\n```',
    ].join('\n');
    expect(parseFindings(text)).toEqual({ verdict: 'comment', findings: [] });
  });

  test('missing block ⇒ null (plain coding summaries, pre-MC-R4 reviews)', () => {
    expect(parseFindings('Fixed the login flow and verified the tests.')).toBeNull();
    expect(parseFindings('')).toBeNull();
    expect(parseFindings(undefined)).toBeNull();
    expect(parseFindings(42)).toBeNull();
  });

  test('malformed JSON inside the fence ⇒ null, never a throw', () => {
    expect(parseFindings('```findings-json\n{"verdict": "approve", "findings": [\n```')).toBeNull();
    expect(parseFindings('```findings-json\nnot json at all\n```')).toBeNull();
  });

  test('wrong top-level shape ⇒ null: bad verdict, missing findings, array root', () => {
    expect(parseFindings('```findings-json\n{"verdict": "ship-it", "findings": []}\n```')).toBeNull();
    expect(parseFindings('```findings-json\n{"verdict": "approve"}\n```')).toBeNull();
    expect(parseFindings('```findings-json\n{"verdict": "approve", "findings": {}}\n```')).toBeNull();
    expect(parseFindings('```findings-json\n[]\n```')).toBeNull();
    expect(parseFindings('```findings-json\n"approve"\n```')).toBeNull();
  });

  test('invalid entries are dropped; valid ones survive', () => {
    const text = `\`\`\`findings-json\n${JSON.stringify({
      verdict: 'comment',
      findings: [
        { severity: 'blocker', title: 'wrong severity vocabulary', detail: 'dropped' },
        { severity: 'high', title: '', detail: 'empty title dropped' },
        { severity: 'medium', detail: 'no title dropped' },
        'not an object',
        null,
        { severity: 'medium', title: 'kept', detail: 'valid' },
      ],
    })}\n\`\`\``;
    expect(parseFindings(text)).toEqual({
      verdict: 'comment',
      findings: [{ severity: 'medium', title: 'kept', detail: 'valid' }],
    });
  });

  test('malformed optional fields are dropped from the finding, not fatal', () => {
    const text = `\`\`\`findings-json\n${JSON.stringify({
      verdict: 'comment',
      findings: [
        { severity: 'low', file: 17, line: 'forty-two', title: 'bad file+line', detail: '' },
        { severity: 'low', file: '', line: -3, title: 'empty file, negative line' },
      ],
    })}\n\`\`\``;
    expect(parseFindings(text)).toEqual({
      verdict: 'comment',
      findings: [
        { severity: 'low', title: 'bad file+line', detail: '' },
        { severity: 'low', title: 'empty file, negative line', detail: '' },
      ],
    });
  });
});

describe('severityCounts', () => {
  test('counts by severity', () => {
    const parsed = parseFindings(GOOD_BLOCK)!;
    expect(severityCounts(parsed.findings)).toEqual({ high: 1, medium: 0, low: 1 });
    expect(severityCounts([])).toEqual({ high: 0, medium: 0, low: 0 });
  });
});
