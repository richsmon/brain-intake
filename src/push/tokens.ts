// BI-C3: Expo push-token registry. A single JSON file next to the session
// logs (same data dir, synchronous fs like the rest of the store code) —
// solo-founder scale, a handful of devices at most. Dedupe on register;
// remove() serves the Expo `DeviceNotRegistered` ticket cleanup.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_NAME = 'push-tokens.json';

export class PushTokenStore {
  private readonly file: string;
  private tokens: string[] | null = null;

  constructor(dir: string) {
    this.file = join(dir, FILE_NAME);
  }

  private load(): string[] {
    if (this.tokens !== null) return this.tokens;
    let out: string[] = [];
    if (existsSync(this.file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'));
        if (Array.isArray(parsed)) out = parsed.filter((t): t is string => typeof t === 'string');
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
    if (tokens.includes(token)) return false;
    tokens.push(token);
    this.persist();
    return true;
  }

  remove(token: string): void {
    const tokens = this.load();
    const i = tokens.indexOf(token);
    if (i === -1) return;
    tokens.splice(i, 1);
    this.persist();
  }

  list(): string[] {
    return [...this.load()];
  }
}
