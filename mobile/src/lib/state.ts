// Pure derivation for the Items list: local queue entries (not yet on the
// server) merged ahead of server items, both newest-first.

import type { ItemSummary } from "./api";
import type { QueueEntry } from "./queue";

export interface DisplayItem {
  id: string;
  state: string;
  title?: string;
  kind?: string;
  local: boolean;
}

export function mergeItems(local: QueueEntry[], server: ItemSummary[]): DisplayItem[] {
  const localItems: DisplayItem[] = [...local]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .map((entry) => ({
      id: entry.id,
      state: entry.lastError ? `stuck: ${entry.lastError}` : "queued (phone)",
      title: `${entry.source} capture`,
      local: true,
    }));

  const serverItems: DisplayItem[] = [...server]
    .sort((a, b) => b.id.localeCompare(a.id))
    .map((item) => ({
      id: item.id,
      state: item.state,
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.kind !== undefined ? { kind: item.kind } : {}),
      local: false,
    }));

  return [...localItems, ...serverItems];
}
