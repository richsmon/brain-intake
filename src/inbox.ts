// Pure inbox primitives mirroring the brain's IN-1 contract (inbox/README.md).
// Semantics must stay byte-compatible with tools/brain-loop/intake.py in the
// brain repo; the contract doc is the single arbiter.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVENT_FILE = 'events.jsonl';

export type InboxEvent = { event: string; ts?: string } & Record<string, unknown>;

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function itemId(content: Buffer, date: string): string {
  return `${date}-${createHash('sha256').update(content).digest('hex').slice(0, 8)}`;
}

export function appendEvent(itemDir: string, event: InboxEvent): void {
  const stamped = { ts: utcNow(), ...event };
  appendFileSync(join(itemDir, EVENT_FILE), `${JSON.stringify(stamped)}\n`, 'utf-8');
}

export const TERMINAL_EVENTS = new Set(['became', 'needs-human', 'deferred', 'categorized']);

export const CAPTURE_SOURCES = new Set(['share-sheet', 'voice', 'text', 'photo']);

export interface CreateItemOptions {
  source: string;
  ext: string;
  originalName?: string;
  deviceTs?: string;
}

export interface CreateItemResult {
  id: string;
  deduped: boolean;
}

export function findItemBySha(inboxDir: string, sha: string): string | null {
  for (const entry of readdirSync(inboxDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const e of readEvents(join(inboxDir, entry.name))) {
      if (e.event === 'captured' && e.sha === sha) return entry.name;
    }
  }
  return null;
}

export function createItem(inboxDir: string, payload: Buffer, opts: CreateItemOptions): CreateItemResult {
  if (!CAPTURE_SOURCES.has(opts.source)) {
    throw new Error(`unknown source: ${opts.source}`);
  }
  const sha = createHash('sha256').update(payload).digest('hex');
  const existing = findItemBySha(inboxDir, sha);
  if (existing) return { id: existing, deduped: true };

  const id = itemId(payload, utcNow().slice(0, 10));
  const dir = join(inboxDir, id);
  mkdirSync(dir, { recursive: true });
  const payloadName = `payload.${opts.ext}`;
  writeFileSync(join(dir, payloadName), payload);
  appendEvent(dir, {
    event: 'captured',
    source: opts.source,
    sha,
    ...(opts.originalName !== undefined ? { original_name: opts.originalName } : {}),
    payload: payloadName,
    ...(opts.deviceTs !== undefined ? { device_ts: opts.deviceTs } : {}),
  });
  appendEvent(dir, { event: 'queued' });
  return { id, deduped: false };
}

export type ItemState = 'open' | 'became' | 'needs-human' | 'deferred' | 'categorized';

/**
 * Derive the item's state from its trail. Per inbox/README a `queued` event
 * appended after a terminal one re-opens the item, so the walk is ordered —
 * not a set-membership check.
 */
export function itemState(events: InboxEvent[]): ItemState {
  let state: ItemState = 'open';
  for (const e of events) {
    if (TERMINAL_EVENTS.has(e.event)) state = e.event as ItemState;
    else if (e.event === 'queued') state = 'open';
  }
  return state;
}

export function knownShas(inboxDir: string): Set<string> {
  const shas = new Set<string>();
  for (const entry of readdirSync(inboxDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const e of readEvents(join(inboxDir, entry.name))) {
      if (e.event === 'captured' && typeof e.sha === 'string' && e.sha) shas.add(e.sha);
    }
  }
  return shas;
}

export function readEvents(itemDir: string): InboxEvent[] {
  const p = join(itemDir, EVENT_FILE);
  if (!existsSync(p)) return [];
  const out: InboxEvent[] = [];
  for (const raw of readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as InboxEvent);
    } catch {
      continue;
    }
  }
  return out;
}
