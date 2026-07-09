import type { SettingsStore } from "../src/lib/settings";
import { loadSeenIds, markBecameSeen, unseenBecameCount } from "../src/lib/read-badge";

function memoryStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
  };
}

const items = [
  { id: "a", state: "became" },
  { id: "b", state: "became" },
  { id: "c", state: "classified" },
  { id: "d", state: "queued (phone)" },
];

describe("read badge", () => {
  it("counts became items the founder has not seen yet", async () => {
    expect(unseenBecameCount(items, new Set())).toBe(2);
    expect(unseenBecameCount(items, new Set(["a"]))).toBe(1);
    expect(unseenBecameCount(items, new Set(["a", "b"]))).toBe(0);
  });

  it("marking seen persists the became ids and empties the badge", async () => {
    const store = memoryStore();
    await markBecameSeen(items, store);
    const seen = await loadSeenIds(store);
    expect(unseenBecameCount(items, seen)).toBe(0);
    expect(seen.has("c")).toBe(false); // only became ids are remembered
  });

  it("survives a corrupt store gracefully", async () => {
    const store = memoryStore();
    store.data.set("brain.seenBecame", "not json{");
    expect((await loadSeenIds(store)).size).toBe(0);
  });
});
