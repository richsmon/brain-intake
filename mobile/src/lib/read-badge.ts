// Read badge: how many items *became* something since the founder last looked.
// "Seen" is a persisted id set — marked when the Read tab is opened. The badge
// is the reward loop made visible: your thought turned into an artifact.

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { SettingsStore } from "./settings";

const SEEN_KEY = "brain.seenBecame";

interface BadgeItem {
  id: string;
  state: string;
}

export async function loadSeenIds(store: SettingsStore = AsyncStorage): Promise<Set<string>> {
  try {
    const raw = await store.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function unseenBecameCount(items: BadgeItem[], seen: Set<string>): number {
  return items.filter((item) => item.state === "became" && !seen.has(item.id)).length;
}

export async function markBecameSeen(
  items: BadgeItem[],
  store: SettingsStore = AsyncStorage,
): Promise<void> {
  const seen = await loadSeenIds(store);
  for (const item of items) {
    if (item.state === "became") seen.add(item.id);
  }
  await store.setItem(SEEN_KEY, JSON.stringify([...seen]));
}
