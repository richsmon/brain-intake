// BI-C3: Expo push-token registry. A single JSON file next to the session
// logs (same data dir, synchronous fs like the rest of the store code) —
// solo-founder scale, a handful of devices at most. Dedupe on register;
// remove() serves the Expo `DeviceNotRegistered` ticket cleanup.
// BI-C7: each token carries its `lastSend` outcome so GET /push/status can
// answer "did the last push reach this device?" — the T-15 e2e loss left no
// trace anywhere, this is the persistent half of the fix. The file upgrades
// in place from the legacy plain-string-array format on first write.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_NAME = 'push-tokens.json';

/** Outcome of the most recent delivery attempt sequence for one token. */
export interface PushSendStatus {
  ts: string;
  ok: boolean;
  /** APNs HTTP status when Apple answered. */
  status?: number;
  /** Error class + message when the transport failed (timeout, socket, …). */
  error?: string;
}

export interface PushTokenEntry {
  token: string;
  lastSend?: PushSendStatus;
}

function parseEntry(raw: unknown): PushTokenEntry | null {
  if (typeof raw === 'string') return { token: raw }; // legacy format
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as { token?: unknown; lastSend?: unknown };
  if (typeof o.token !== 'string') return null;
  const lastSend = o.lastSend as PushSendStatus | undefined;
  return {
    token: o.token,
    ...(typeof lastSend === 'object' && lastSend !== null ? { lastSend } : {}),
  };
}

export class PushTokenStore {
  private readonly file: string;
  private tokens: PushTokenEntry[] | null = null;

  constructor(dir: string) {
    this.file = join(dir, FILE_NAME);
  }

  private load(): PushTokenEntry[] {
    if (this.tokens !== null) return this.tokens;
    let out: PushTokenEntry[] = [];
    if (existsSync(this.file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'));
        if (Array.isArray(parsed)) {
          out = parsed.map(parseEntry).filter((e): e is PushTokenEntry => e !== null);
        }
      } catch {
        // Corrupt registry ⇒ start clean; devices re-register on next app open.
      }
    }
    this.tokens = out;
    return out;
  }

  private persist(): void {
    writeFileSync(this.file, `${JSON.stringify(this.tokens ?? [])}\n`, 'utf-8');
  }

  /** Returns true when the token was new, false on a dedupe hit. */
  register(token: string): boolean {
    const tokens = this.load();
    if (tokens.some((e) => e.token === token)) return false;
    tokens.push({ token });
    this.persist();
    return true;
  }

  remove(token: string): void {
    const tokens = this.load();
    const i = tokens.findIndex((e) => e.token === token);
    if (i === -1) return;
    tokens.splice(i, 1);
    this.persist();
  }

  /** BI-C7: persist the outcome of the latest send. No-op for unknown tokens. */
  recordSend(token: string, status: PushSendStatus): void {
    const entry = this.load().find((e) => e.token === token);
    if (entry === undefined) return;
    entry.lastSend = status;
    this.persist();
  }

  list(): string[] {
    return this.load().map((e) => e.token);
  }

  /** BI-C7: tokens with their lastSend status, for GET /push/status. */
  entries(): PushTokenEntry[] {
    return this.load().map((e) => ({ ...e }));
  }
}
