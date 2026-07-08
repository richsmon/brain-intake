import type { ItemSummary } from "../src/lib/api";
import type { QueueEntry } from "../src/lib/queue";
import { mergeItems } from "../src/lib/state";

function entry(id: string, createdAt: string, source = "text"): QueueEntry {
  return {
    id,
    kind: "text",
    source: source as QueueEntry["source"],
    ext: "md",
    deviceTs: createdAt,
    createdAt,
    tries: 0,
  };
}

describe("mergeItems", () => {
  it("puts local pending first (newest first), then server items (newest first)", () => {
    const local = [entry("q-1", "2026-07-08T10:00:00Z"), entry("q-2", "2026-07-08T11:00:00Z")];
    const server: ItemSummary[] = [
      { id: "2026-07-07-aaaa1111", state: "became", lastEvent: "became", title: "Old" },
      { id: "2026-07-08-bbbb2222", state: "open", lastEvent: "queued" },
    ];
    const merged = mergeItems(local, server);
    expect(merged.map((m) => m.id)).toEqual([
      "q-2",
      "q-1",
      "2026-07-08-bbbb2222",
      "2026-07-07-aaaa1111",
    ]);
  });

  it("labels local entries as queued (phone) with their source", () => {
    const merged = mergeItems([entry("q-1", "2026-07-08T10:00:00Z", "voice")], []);
    expect(merged[0]).toEqual({
      id: "q-1",
      state: "queued (phone)",
      title: "voice capture",
      local: true,
    });
  });

  it("passes server state and title through", () => {
    const merged = mergeItems(
      [],
      [{ id: "2026-07-08-cccc3333", state: "needs-human", lastEvent: "needs-human", title: "T" }],
    );
    expect(merged[0]).toEqual({
      id: "2026-07-08-cccc3333",
      state: "needs-human",
      title: "T",
      local: false,
    });
  });
});
