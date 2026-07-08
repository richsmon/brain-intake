import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readEvents } from '../src/inbox.js';
import { buildServer } from '../src/server.js';

function tmpBrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  mkdirSync(join(root, 'inbox'));
  return root;
}

function form(fields: Record<string, string>, fileName: string, fileContent: Buffer): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(fileContent)]), fileName);
  return fd;
}

describe('POST /items (multipart: voice / photo)', () => {
  test('voice note lands as payload.m4a with captured/queued events', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'voice', deviceTs: '2026-07-07T08:15:00Z' }, 'memo.m4a', Buffer.from('fake-audio')),
    });

    expect(res.statusCode).toBe(201);
    const { id, deduped } = res.json();
    expect(deduped).toBe(false);

    const dir = join(root, 'inbox', id);
    expect(readFileSync(join(dir, 'payload.m4a'), 'utf-8')).toBe('fake-audio');
    const events = readEvents(dir);
    expect(events[0]).toMatchObject({
      event: 'captured', source: 'voice', original_name: 'memo.m4a',
      payload: 'payload.m4a', device_ts: '2026-07-07T08:15:00Z',
    });
    expect(events[1]!.event).toBe('queued');
  });

  test('photo lands with its extension', async () => {
    const app = buildServer({ brainRoot: tmpBrain() });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'photo' }, 'whiteboard.jpg', Buffer.from('fake-jpeg')),
    });
    expect(res.statusCode).toBe(201);
  });

  test('disallowed extension → 400', async () => {
    const app = buildServer({ brainRoot: tmpBrain() });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'photo' }, 'malware.exe', Buffer.from('nope')),
    });
    expect(res.statusCode).toBe(400);
  });

  test('JSON-only sources rejected on multipart → 400', async () => {
    const app = buildServer({ brainRoot: tmpBrain() });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'text' }, 'note.m4a', Buffer.from('x')),
    });
    expect(res.statusCode).toBe(400);
  });

  test('file over the size cap → 413', async () => {
    const app = buildServer({ brainRoot: tmpBrain(), maxUploadBytes: 8 });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'voice' }, 'memo.m4a', Buffer.from('way more than eight bytes')),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('transcription hook (WHISPER_CMD)', () => {
  async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  test('voice upload triggers fire-and-forget transcription: transcript.md + transcribed event', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root, whisperCmd: 'echo spoken words from {input}' });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'voice' }, 'memo.m4a', Buffer.from('fake-audio-1')),
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    const dir = join(root, 'inbox', id);

    await waitFor(() => existsSync(join(dir, 'transcript.md')));
    expect(readFileSync(join(dir, 'transcript.md'), 'utf-8')).toContain('spoken words from');
    await waitFor(() => readEvents(dir).some((e) => e.event === 'transcribed'));
  });

  test('photo upload does not trigger transcription', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root, whisperCmd: 'echo never {input}' });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'photo' }, 'p.jpg', Buffer.from('fake-jpg')),
    });
    const { id } = res.json();
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(join(root, 'inbox', id, 'transcript.md'))).toBe(false);
  });

  test('no whisperCmd → no transcription attempted', async () => {
    const root = tmpBrain();
    const app = buildServer({ brainRoot: root });
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      payload: form({ source: 'voice' }, 'memo.m4a', Buffer.from('fake-audio-2')),
    });
    const { id } = res.json();
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(join(root, 'inbox', id, 'transcript.md'))).toBe(false);
  });
});
