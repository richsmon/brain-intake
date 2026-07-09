import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeIntakeTrigger } from '../src/intake-trigger.js';
import { makeApprovals } from '../src/approvals.js';

function tmpBrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  mkdirSync(join(root, 'inbox'));
  return root;
}

const OPEN_QUESTION = `# Question: Is the red note "rotate quarterly"?

**Date:** 2026-07-09
**Asked by:** richsmon (brain-loop, automated)
**Category:** intake
**Status:** open

## Question

I can read the diagram but not the red margin note.

## Context

Photo capture from the whiteboard.
`;

describe('GET /questions', () => {
  test('lists open questions with title and body; answered ones stay out', async () => {
    const root = tmpBrain();
    mkdirSync(join(root, 'questions'));
    writeFileSync(join(root, 'questions', '2026-07-09-red-note.md'), OPEN_QUESTION);
    writeFileSync(
      join(root, 'questions', '2026-07-08-old.md'),
      OPEN_QUESTION.replace('**Status:** open', '**Status:** answered'),
    );
    const app = buildServer({ brainRoot: root });

    const res = await app.inject({ method: 'GET', url: '/questions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('2026-07-09-red-note');
    expect(body[0].title).toContain('rotate quarterly');
    expect(body[0].body).toContain('red margin note');
  });
});

describe('POST /questions/:id/answer', () => {
  test('appends the answer, flips status, self-commits pathspec-limited', async () => {
    const root = tmpBrain();
    mkdirSync(join(root, 'questions'));
    writeFileSync(join(root, 'questions', '2026-07-09-red-note.md'), OPEN_QUESTION);
    const git: string[][] = [];
    const app = buildServer({
      brainRoot: root,
      questionsExec: async (_cmd, args) => {
        git.push(args);
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/questions/2026-07-09-red-note/answer',
      payload: { text: 'It says rotate quarterly.' },
    });
    expect(res.statusCode).toBe(200);

    const src = readFileSync(join(root, 'questions', '2026-07-09-red-note.md'), 'utf-8');
    expect(src).toContain('**Status:** answered');
    expect(src).toContain('It says rotate quarterly.');
    expect(git.some((args) => args[0] === 'commit')).toBe(true);

    // Second answer bounces — the question is no longer open.
    const again = await app.inject({
      method: 'POST',
      url: '/questions/2026-07-09-red-note/answer',
      payload: { text: 'twice?' },
    });
    expect(again.statusCode).toBe(404);
  });

  test('rejects empty text and unknown ids', async () => {
    const app = buildServer({ brainRoot: tmpBrain() });
    expect(
      (await app.inject({ method: 'POST', url: '/questions/x/answer', payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/questions/nope/answer', payload: { text: 'hi' } }))
        .statusCode,
    ).toBe(404);
  });
});

describe('approvals', () => {
  test('lists open loop/* PRs with the verifier verdict', async () => {
    const calls: string[][] = [];
    const approvals = makeApprovals({
      brainRoot: '/b',
      execFn: async (_cmd, args) => {
        calls.push(args);
        if (args[1] === 'list')
          return JSON.stringify([
            { number: 30, title: 'Fix stale status', headRefName: 'loop/stale', url: 'u1' },
            { number: 9, title: 'Feature PR', headRefName: 'feat/x', url: 'u2' },
          ]);
        return JSON.stringify({ comments: [{ body: 'VERDICT: PASS — scoped and correct' }] });
      },
    });
    const out = await approvals.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ number: 30, branch: 'loop/stale', verdict: expect.stringContaining('PASS') });
  });

  test('approve merges with squash; reject closes with a comment', async () => {
    const calls: string[][] = [];
    const approvals = makeApprovals({
      brainRoot: '/b',
      execFn: async (_cmd, args) => {
        calls.push(args);
        return '';
      },
    });
    await approvals.approve(30);
    await approvals.reject(31);
    expect(calls).toContainEqual(['pr', 'merge', '30', '--squash']);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'close' && args[2] === '31')).toBe(true);
  });

  test('the approvals routes proxy to the injected implementation', async () => {
    const approve = vi.fn(async () => {});
    const app = buildServer({
      brainRoot: tmpBrain(),
      approvals: { list: async () => [], approve, reject: async () => {} },
    });
    expect((await app.inject({ method: 'GET', url: '/approvals' })).json()).toEqual([]);
    await app.inject({ method: 'POST', url: '/approvals/30/approve' });
    expect(approve).toHaveBeenCalledWith(30);
  });
});

describe('fleet + instant intake', () => {
  test('fleet reports kill-switch state and the newest loop report', async () => {
    const root = tmpBrain();
    mkdirSync(join(root, 'reports', 'brain-loop'), { recursive: true });
    writeFileSync(join(root, 'reports', 'brain-loop', '2026-07-09-richsmon.md'), 'x');
    writeFileSync(join(root, 'reports', 'brain-loop', 'README.md'), 'not a report');
    const app = buildServer({ brainRoot: root });
    expect((await app.inject({ method: 'GET', url: '/fleet' })).json()).toEqual({
      loopDisabled: false,
      lastReport: '2026-07-09-richsmon.md',
    });
  });

  test('a text capture fires the intake trigger', async () => {
    const fire = vi.fn();
    const app = buildServer({ brainRoot: tmpBrain(), intakeTrigger: { fire } });
    await app.inject({ method: 'POST', url: '/items', payload: { source: 'text', text: 'now!' } });
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

describe('makeIntakeTrigger', () => {
  test('latches to one running pass and queues exactly one re-run', () => {
    const exits: (() => void)[] = [];
    const spawned: string[][] = [];
    const trigger = makeIntakeTrigger({
      brainRoot: '/b',
      spawnFn: (_cmd, args) => {
        spawned.push(args);
        return {
          on: (event, cb) => {
            if (event === 'exit') exits.push(cb);
          },
        };
      },
    });
    trigger.fire();
    trigger.fire();
    trigger.fire();
    expect(spawned).toHaveLength(1); // latched
    exits.shift()!();
    expect(spawned).toHaveLength(2); // one queued re-run
    exits.shift()!();
    expect(spawned).toHaveLength(2); // nothing else pending
    expect(spawned[0]).toContain('--intake-only');
  });
});
