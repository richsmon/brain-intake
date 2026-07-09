// A1 Questions: the brain's needs-human queue, served to the phone. Questions
// are markdown files in <brain>/questions/ with a `**Status:** open|answered`
// field — the file IS the state. Answering appends an Answer section, flips
// the status, and self-commits pathspec-limited (the intake-hardening pattern)
// so an unattended write never lingers as an untracked orphan.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface QuestionSummary {
  id: string;
  title: string;
  body: string;
  date?: string;
  category?: string;
}

export type ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<void>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
  });

function headerField(src: string, name: string): string | undefined {
  return src.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`))?.[1]?.trim();
}

export function listOpenQuestions(brainRoot: string): QuestionSummary[] {
  const dir = join(brainRoot, 'questions');
  if (!existsSync(dir)) return [];
  const out: QuestionSummary[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()) {
    const src = readFileSync(join(dir, file), 'utf-8');
    if ((headerField(src, 'Status') ?? '').toLowerCase() !== 'open') continue;
    const title = src.match(/^# Question:\s*(.+)$/m)?.[1]?.trim() ?? file;
    const body = src.split(/^## Question\s*$/m)[1]?.split(/^## /m)[0]?.trim() ?? '';
    const date = headerField(src, 'Date');
    const category = headerField(src, 'Category');
    out.push({
      id: file.replace(/\.md$/, ''),
      title,
      body,
      ...(date !== undefined ? { date } : {}),
      ...(category !== undefined ? { category } : {}),
    });
  }
  return out;
}

export async function answerQuestion(
  brainRoot: string,
  id: string,
  answer: string,
  execFn: ExecFn = defaultExec,
): Promise<boolean> {
  if (!/^[\w.-]+$/.test(id)) return false; // the id is a filename — no path tricks
  const path = join(brainRoot, 'questions', `${id}.md`);
  if (!existsSync(path)) return false;
  let src = readFileSync(path, 'utf-8');
  if ((headerField(src, 'Status') ?? '').toLowerCase() !== 'open') return false;

  src = src.replace(/\*\*Status:\*\*\s*open/i, '**Status:** answered');
  src += `\n## Answer (from phone, ${new Date().toISOString()})\n\n${answer.trim()}\n`;
  writeFileSync(path, src, 'utf-8');

  try {
    const rel = join('questions', `${id}.md`);
    await execFn('git', ['add', rel], { cwd: brainRoot });
    await execFn('git', ['commit', '-m', `questions: answer ${id} (from phone)`, '--', rel], {
      cwd: brainRoot,
    });
  } catch {
    // Commit is best-effort (another session may hold the lock); the answer
    // itself is already on disk and the morning close sweeps stragglers.
  }
  return true;
}
