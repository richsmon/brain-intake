// Composition root: wires settings + api + queue over the real device
// filesystem. Screens import ONLY this module for brain operations, which
// keeps component tests to a single jest.mock target.

import { Paths } from "expo-file-system";

import { makeApi, type Api, type FileSource, type TextSource } from "./api";
import { checkCapturedFile, type FileCheck } from "./file-checks";
import { makeQueue, type FlushReport, type Queue, type QueueEntry } from "./queue";
import { expoQueueFs } from "./queue-fs.expo";
import { makeSettings } from "./settings";

export const settings = makeSettings();

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    queue = makeQueue({ fs: expoQueueFs, dir: `${Paths.document.uri}queue` });
  }
  return queue;
}

export async function getApi(): Promise<Api> {
  return makeApi(await settings.getBaseUrl());
}

/** Background-task shape: capture returns as soon as the entry is queued
 * locally; the flush attempt runs fire-and-forget. */
export async function captureText(text: string, source: TextSource = "text"): Promise<void> {
  await getQueue().enqueue({ kind: "text", source, text });
  void flushQueue();
}

/** Validates against the server's constraints, then queues the file. Returns
 * the failed check instead of throwing so screens can surface the reason. */
export async function captureFile(input: {
  source: FileSource;
  uri: string;
  name?: string;
  sizeBytes?: number;
}): Promise<FileCheck> {
  const check = checkCapturedFile({
    nameOrUri: input.name ?? input.uri,
    sizeBytes: input.sizeBytes,
  });
  if (!check.ok) return check;
  await getQueue().enqueue({
    kind: "file",
    source: input.source,
    sourceUri: input.uri,
    ext: check.ext,
    originalName: input.name,
  });
  void flushQueue();
  return check;
}

export async function flushQueue(): Promise<FlushReport | null> {
  try {
    return await getQueue().flush(await getApi());
  } catch {
    return null;
  }
}

export async function pendingEntries(): Promise<QueueEntry[]> {
  return getQueue().pending();
}
