// Composition root: wires settings + api + queue over the real device
// filesystem. Screens import ONLY this module for brain operations, which
// keeps component tests to a single jest.mock target.

import { Paths } from "expo-file-system";

import { makeApi, type Api, type TextSource } from "./api";
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
