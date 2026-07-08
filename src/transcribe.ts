// Host-side STT for audio captures (BI-06). Runs the operator-configured
// WHISPER_CMD on the payload and writes `transcript.md` beside it + appends
// the non-terminal `transcribed` event (contract: inbox/README.md in the
// brain repo, amended universal-brain#28). The payload stays the source of
// truth — transcript.md is derived and re-derivable.
//
// WHISPER_CMD contract: a shell command that prints the transcript to stdout.
// `{input}` is replaced with the quoted audio path; without a placeholder the
// path is appended as the last argument. Recommended local-first default:
// faster-whisper via whisper-ctranslate2 (base model) — see README. Cloud
// fallbacks stay operator-side config, never code.

import { exec } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { appendEvent, readEvents } from './inbox.js';

const execAsync = promisify(exec);

export const AUDIO_EXTS = new Set(['m4a', 'mp3', 'wav']);

// Known whisper phantom phrases — emitted on silence/noise, never spoken.
// Matched against whole lines, case-insensitive, punctuation-insensitive.
const PHANTOM_LINES = new Set(
  [
    'thank you for watching',
    'thanks for watching',
    'thank you',
    'please subscribe',
    'subtitles by the amara org community',
    'dakujem za pozretie',
    'ďakujem za pozretie',
  ].map(normalizeLine),
);

function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function filterHallucinations(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (PHANTOM_LINES.has(normalizeLine(trimmed))) continue;
    // collapse consecutive repetitions (whisper loop artifact)
    if (kept.length > 0 && kept[kept.length - 1] === trimmed) continue;
    kept.push(trimmed);
  }
  return kept.join('\n');
}

export type TranscribeOutcome = 'written' | 'skipped-not-audio' | 'skipped-exists' | 'empty';

export interface TranscribeDeps {
  runCommand?: (cmd: string) => Promise<string>;
}

async function defaultRunCommand(cmd: string): Promise<string> {
  const { stdout } = await execAsync(cmd, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function buildCommand(whisperCmd: string, audioPath: string): string {
  const quoted = `'${audioPath}'`;
  return whisperCmd.includes('{input}')
    ? whisperCmd.replaceAll('{input}', quoted)
    : `${whisperCmd} ${quoted}`;
}

export async function transcribeItem(
  itemDir: string,
  whisperCmd: string,
  deps: TranscribeDeps = {},
): Promise<TranscribeOutcome> {
  if (existsSync(join(itemDir, 'transcript.md'))) return 'skipped-exists';

  const captured = readEvents(itemDir).find((e) => e.event === 'captured');
  const payloadName = typeof captured?.payload === 'string' ? captured.payload : undefined;
  const ext = payloadName?.split('.').pop()?.toLowerCase() ?? '';
  if (payloadName === undefined || !AUDIO_EXTS.has(ext)) return 'skipped-not-audio';

  const run = deps.runCommand ?? defaultRunCommand;
  const raw = await run(buildCommand(whisperCmd, join(itemDir, payloadName)));
  const transcript = filterHallucinations(raw);
  if (!transcript) return 'empty';

  writeFileSync(join(itemDir, 'transcript.md'), transcript, 'utf-8');
  appendEvent(itemDir, { event: 'transcribed', transcript: 'transcript.md' });
  return 'written';
}
