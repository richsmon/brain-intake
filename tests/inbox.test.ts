import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { appendEvent, createItem, itemId, itemState, knownShas, readEvents, utcNow } from '../src/inbox.js';

function tmpItemDir(): string {
  return mkdtempSync(join(tmpdir(), 'inbox-item-'));
}

describe('itemId', () => {
  test('is <date>-<sha256[:8] of content>, matching the inbox/README scheme', () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(itemId(Buffer.from('hello'), '2026-07-07')).toBe('2026-07-07-2cf24dba');
  });

  test('same content, same id; different content, different id', () => {
    const a = itemId(Buffer.from('hello'), '2026-07-07');
    expect(itemId(Buffer.from('hello'), '2026-07-07')).toBe(a);
    expect(itemId(Buffer.from('world'), '2026-07-07')).not.toBe(a);
  });
});

describe('utcNow', () => {
  test('formats as YYYY-MM-DDTHH:MM:SSZ (seconds precision, Z suffix)', () => {
    expect(utcNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('appendEvent / readEvents', () => {
  test('round-trips events as one JSON object per line, stamping ts', () => {
    const dir = tmpItemDir();
    appendEvent(dir, { event: 'captured', source: 'text', sha: 'abc' });
    appendEvent(dir, { event: 'queued' });

    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const events = readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'captured', source: 'text', sha: 'abc' });
    expect(events[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(events[1]).toMatchObject({ event: 'queued' });
  });

  test('a caller-provided ts wins over the stamp', () => {
    const dir = tmpItemDir();
    appendEvent(dir, { event: 'queued', ts: '2026-01-01T00:00:00Z' });
    expect(readEvents(dir)[0]!.ts).toBe('2026-01-01T00:00:00Z');
  });

  test('readEvents: missing file → [], blank and unparseable lines skipped', () => {
    const dir = tmpItemDir();
    expect(readEvents(dir)).toEqual([]);

    writeFileSync(
      join(dir, 'events.jsonl'),
      '{"ts":"2026-01-01T00:00:00Z","event":"queued"}\n\nnot json\n',
    );
    expect(readEvents(dir)).toEqual([{ ts: '2026-01-01T00:00:00Z', event: 'queued' }]);
  });
});

describe('itemState', () => {
  test('no terminal event → open', () => {
    expect(itemState([])).toBe('open');
    expect(itemState([{ event: 'captured' }, { event: 'queued' }])).toBe('open');
    expect(itemState([{ event: 'captured' }, { event: 'queued' }, { event: 'classified' }])).toBe('open');
  });

  test('terminal events are terminal', () => {
    expect(itemState([{ event: 'captured' }, { event: 'became' }])).toBe('became');
    expect(itemState([{ event: 'captured' }, { event: 'needs-human' }])).toBe('needs-human');
  });

  test('a queued event after a terminal re-opens the item (inbox/README re-open rule)', () => {
    expect(itemState([{ event: 'captured' }, { event: 'became' }, { event: 'queued' }])).toBe('open');
  });
});

describe('knownShas', () => {
  test('collects sha fields from captured events across item dirs', () => {
    const inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
    const a = join(inbox, '2026-07-07-aaaaaaaa');
    const b = join(inbox, '2026-07-07-bbbbbbbb');
    mkdirSync(a);
    mkdirSync(b);
    appendEvent(a, { event: 'captured', sha: 'sha-a' });
    appendEvent(b, { event: 'captured', sha: 'sha-b' });
    appendEvent(b, { event: 'became', artifact: 'x.md' });
    writeFileSync(join(inbox, 'README.md'), 'not an item');
    mkdirSync(join(inbox, 'no-events'));

    expect(knownShas(inbox)).toEqual(new Set(['sha-a', 'sha-b']));
  });
});

describe('createItem', () => {
  test('creates inbox/<id>/payload.<ext> + captured/queued events per contract', () => {
    const inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
    const res = createItem(inbox, Buffer.from('hello'), {
      source: 'text',
      ext: 'md',
      originalName: 'note.md',
      deviceTs: '2026-07-07T10:00:00Z',
    });

    expect(res.deduped).toBe(false);
    expect(res.id).toMatch(/^\d{4}-\d{2}-\d{2}-2cf24dba$/);

    const dir = join(inbox, res.id);
    expect(readFileSync(join(dir, 'payload.md'), 'utf-8')).toBe('hello');

    const events = readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: 'captured',
      source: 'text',
      sha: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      original_name: 'note.md',
      payload: 'payload.md',
      device_ts: '2026-07-07T10:00:00Z',
    });
    expect(events[1]!.event).toBe('queued');
  });

  test('optional fields are omitted, not null', () => {
    const inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
    const res = createItem(inbox, Buffer.from('bare'), { source: 'text', ext: 'md' });
    const captured = readEvents(join(inbox, res.id))[0]!;
    expect('original_name' in captured).toBe(false);
    expect('device_ts' in captured).toBe(false);
  });

  test('same payload twice → same id, deduped, nothing rewritten', () => {
    const inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
    const first = createItem(inbox, Buffer.from('hello'), { source: 'text', ext: 'md' });
    const second = createItem(inbox, Buffer.from('hello'), { source: 'share-sheet', ext: 'md' });

    expect(second).toEqual({ id: first.id, deduped: true });
    expect(readEvents(join(inbox, first.id))).toHaveLength(2);
    expect(readdirSync(inbox).filter((n) => n.startsWith('20'))).toHaveLength(1);
  });

  test('rejects unknown source', () => {
    const inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
    expect(() => createItem(inbox, Buffer.from('x'), { source: 'email', ext: 'md' })).toThrow(/source/);
  });
});
