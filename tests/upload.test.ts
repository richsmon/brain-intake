import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
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
