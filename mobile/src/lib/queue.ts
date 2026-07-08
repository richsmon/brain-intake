// Offline-first capture queue. Entries live as directories under `dir`:
//   <dir>/<uuid>/meta.json + payload.<ext>
// An entry is removed ONLY after the server answers 201 — the server's
// content-sha dedupe makes at-least-once retries safe, so a crash between
// POST and remove costs nothing.

import { ApiError, type Api, type FileExt, type FileSource, type TextSource } from "./api";

export interface QueueFs {
  ensureDir(path: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  readText(path: string): Promise<string>;
  copy(src: string, dest: string): Promise<void>;
  listDirs(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export type Capture =
  | { kind: "text"; source: TextSource; text: string }
  | { kind: "file"; source: FileSource; sourceUri: string; ext: FileExt; originalName?: string };

export interface QueueEntry {
  id: string;
  kind: "text" | "file";
  source: TextSource | FileSource;
  ext: string;
  originalName?: string;
  deviceTs: string;
  createdAt: string;
  tries: number;
  /** Message of the most recent flush failure — surfaced in the Items UI so a
   * stuck entry explains itself. */
  lastError?: string;
}

export interface FlushReport {
  sent: number;
  left: number;
}

/** Native file uploader (expo-fs File.upload) — RN's fetch cannot reliably
 * stream file:// bodies, so file entries go through this seam when provided.
 * Must throw ApiError on failure. */
export type FileUploader = (
  payloadPath: string,
  meta: { source: FileSource; name: string; ext: FileExt; deviceTs: string },
) => Promise<void>;

interface QueueDeps {
  fs: QueueFs;
  dir: string;
  newId?: () => string;
  now?: () => string;
  uploadFile?: FileUploader;
}

function defaultNewId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeQueue({ fs, dir, newId = defaultNewId, now = () => new Date().toISOString(), uploadFile }: QueueDeps) {
  const entryDir = (id: string) => `${dir}/${id}`;
  const metaPath = (id: string) => `${entryDir(id)}/meta.json`;
  const payloadPath = (e: Pick<QueueEntry, "id" | "ext">) => `${entryDir(e.id)}/payload.${e.ext}`;

  async function writeMeta(entry: QueueEntry): Promise<void> {
    await fs.writeText(metaPath(entry.id), JSON.stringify(entry, null, 2) + "\n");
  }

  async function pending(): Promise<QueueEntry[]> {
    if (!(await fs.exists(dir))) return [];
    const ids = await fs.listDirs(dir);
    const entries = await Promise.all(
      ids.map(async (id) => JSON.parse(await fs.readText(metaPath(id))) as QueueEntry),
    );
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  return {
    pending,

    async enqueue(capture: Capture): Promise<string> {
      const id = newId();
      const ts = now();
      const entry: QueueEntry = {
        id,
        kind: capture.kind,
        source: capture.source,
        ext: capture.kind === "text" ? "md" : capture.ext,
        ...(capture.kind === "file" && capture.originalName !== undefined
          ? { originalName: capture.originalName }
          : {}),
        deviceTs: ts,
        createdAt: ts,
        tries: 0,
      };
      await fs.ensureDir(entryDir(id));
      if (capture.kind === "text") {
        await fs.writeText(payloadPath(entry), capture.text);
      } else {
        await fs.copy(capture.sourceUri, payloadPath(entry));
      }
      await writeMeta(entry);
      return id;
    },

    async flush(api: Api): Promise<FlushReport> {
      const entries = await pending();
      if (entries.length === 0) return { sent: 0, left: 0 };

      try {
        await api.health();
      } catch {
        return { sent: 0, left: entries.length };
      }

      let sent = 0;
      for (const entry of entries) {
        try {
          if (entry.kind === "text") {
            await api.createText({
              source: entry.source as TextSource,
              text: await fs.readText(payloadPath(entry)),
              deviceTs: entry.deviceTs,
            });
          } else if (uploadFile) {
            await uploadFile(payloadPath(entry), {
              source: entry.source as FileSource,
              name: entry.originalName ?? `payload.${entry.ext}`,
              ext: entry.ext as FileExt,
              deviceTs: entry.deviceTs,
            });
          } else {
            await api.createFile({
              source: entry.source as FileSource,
              uri: payloadPath(entry),
              name: entry.originalName ?? `payload.${entry.ext}`,
              ext: entry.ext as FileExt,
              deviceTs: entry.deviceTs,
            });
          }
          await fs.remove(entryDir(entry.id));
          sent++;
        } catch (err) {
          entry.lastError = err instanceof Error ? err.message : String(err);
          if (err instanceof ApiError && err.kind === "unreachable") {
            // Connectivity died mid-flush — every later entry would fail too.
            await writeMeta(entry);
            break;
          }
          entry.tries += 1;
          await writeMeta(entry);
        }
      }
      return { sent, left: entries.length - sent };
    },
  };
}

export type Queue = ReturnType<typeof makeQueue>;
