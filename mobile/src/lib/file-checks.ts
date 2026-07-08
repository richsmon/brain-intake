// Client-side mirror of the server's upload constraints (ext whitelist +
// 25 MB cap) — reject at enqueue time instead of queueing something the
// server will 413/400.

import type { FileExt } from "./api";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTS: readonly FileExt[] = ["jpg", "jpeg", "png", "heic", "m4a", "mp3", "wav"];

export type FileCheck = { ok: true; ext: FileExt } | { ok: false; reason: string };

export function checkCapturedFile({
  nameOrUri,
  sizeBytes,
}: {
  nameOrUri: string;
  sizeBytes?: number;
}): FileCheck {
  const match = /\.([A-Za-z0-9]+)$/.exec(nameOrUri);
  const ext = match ? match[1].toLowerCase() : null;
  if (!ext || !(ALLOWED_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, reason: `Unsupported file type: ${ext ?? "(none)"}` };
  }
  if (sizeBytes !== undefined && sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, reason: "File too large (max 25 MB)" };
  }
  return { ok: true, ext: ext as FileExt };
}
