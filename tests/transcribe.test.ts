import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { appendEvent, readEvents } from '../src/inbox.js';
import { filterHallucinations, transcribeItem } from '../src/transcribe.js';

function audioItem(root: string, id = '2026-07-08-aaaa1111'): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'payload.m4a'), Buffer.from([0x00, 0x01]));
  appendEvent(dir, { event: 'captured', source: 'voice', sha: 'x', payload: 'payload.m4a' });
  appendEvent(dir, { event: 'queued' });
  return dir;
}

describe('filterHallucinations', () => {
  it('passes normal text through', () => {
    expect(filterHallucinations('Buy milk and call the notary tomorrow.')).toBe(
      'Buy milk and call the notary tomorrow.',
    );
  });

  it('drops known whisper phantom lines', () => {
    const raw = 'Real thought about gotam.\nThank you for watching.\n';
    expect(filterHallucinations(raw)).toBe('Real thought about gotam.');
  });

  it('collapses 3+ identical consecutive lines to one', () => {
    const raw = 'same idea\nsame idea\nsame idea\nsame idea';
    expect(filterHallucinations(raw)).toBe('same idea');
  });

  it('returns empty string for hallucination-only output', () => {
    expect(filterHallucinations('Thanks for watching!\n')).toBe('');
  });
});

describe('transcribeItem', () => {
  it('runs the command on the audio payload and writes transcript.md + transcribed event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bi06-'));
    const dir = audioItem(root);
    const runCommand = vi.fn(async () => 'a spoken thought about the brain\n');

    const outcome = await transcribeItem(dir, 'whisper-cli {input}', { runCommand });

    expect(outcome).toBe('written');
    expect(runCommand).toHaveBeenCalledWith(`whisper-cli '${join(dir, 'payload.m4a')}'`);
    expect(readFileSync(join(dir, 'transcript.md'), 'utf-8')).toBe(
      'a spoken thought about the brain',
    );
    const events = readEvents(dir);
    const transcribed = events.find((e) => e.event === 'transcribed');
    expect(transcribed?.transcript).toBe('transcript.md');
    expect(typeof transcribed?.ts).toBe('string');
  });

  it('appends the quoted path when the command has no {input} placeholder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bi06-'));
    const dir = audioItem(root);
    const runCommand = vi.fn(async () => 'ok');
    await transcribeItem(dir, 'whisper-cli --model base', { runCommand });
    expect(runCommand).toHaveBeenCalledWith(
      `whisper-cli --model base '${join(dir, 'payload.m4a')}'`,
    );
  });

  it('skips non-audio payloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bi06-'));
    const dir = join(root, '2026-07-08-bbbb2222');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'payload.jpg'), Buffer.from([0xff]));
    appendEvent(dir, { event: 'captured', source: 'photo', sha: 'y', payload: 'payload.jpg' });
    const runCommand = vi.fn(async () => 'never');
    expect(await transcribeItem(dir, 'w {input}', { runCommand })).toBe('skipped-not-audio');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('skips when transcript.md already exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bi06-'));
    const dir = audioItem(root);
    writeFileSync(join(dir, 'transcript.md'), 'already here');
    const runCommand = vi.fn(async () => 'never');
    expect(await transcribeItem(dir, 'w {input}', { runCommand })).toBe('skipped-exists');
    expect(runCommand).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'transcript.md'), 'utf-8')).toBe('already here');
  });

  it('writes nothing when the filtered transcript is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bi06-'));
    const dir = audioItem(root);
    const runCommand = vi.fn(async () => 'Thank you for watching.\n');
    expect(await transcribeItem(dir, 'w {input}', { runCommand })).toBe('empty');
    expect(existsSync(join(dir, 'transcript.md'))).toBe(false);
    expect(readEvents(dir).some((e) => e.event === 'transcribed')).toBe(false);
  });
});
