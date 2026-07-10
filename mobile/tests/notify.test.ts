import type { Digest } from "../src/lib/api";
import { decideNotifications, type NotifyState } from "../src/lib/notify";

const EMPTY: NotifyState = { notifiedActIds: [], digestDate: null };

function digest(over: Partial<Digest["counts"]> = {}): Digest {
  return {
    date: "2026-07-11",
    counts: { captured: 3, became: 1, categorized: 1, needsHuman: 1, cloudApprovals: 0, ...over },
    highlights: [],
    loopDisabled: false,
    lastReport: "2026-07-11-richsmon.md",
  };
}

describe("decideNotifications", () => {
  it("notifies once about a new pending act, in the companion voice", () => {
    const { notifications, next } = decideNotifications(EMPTY, {
      pendingActs: [{ id: "q-1", title: "Is the red note rotate quarterly?" }],
      digest: null,
      now: new Date("2026-07-11T10:00:00Z"),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.body).toContain("Is the red note");
    // same snapshot again → silence
    const second = decideNotifications(next, {
      pendingActs: [{ id: "q-1", title: "Is the red note rotate quarterly?" }],
      digest: null,
      now: new Date("2026-07-11T10:15:00Z"),
    });
    expect(second.notifications).toHaveLength(0);
  });

  it("bundles several new acts into one notification", () => {
    const { notifications } = decideNotifications(EMPTY, {
      pendingActs: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
      ],
      digest: null,
      now: new Date("2026-07-11T10:00:00Z"),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.body).toContain("3");
  });

  it("sends the morning digest once per day, only after 07:00", () => {
    const early = decideNotifications(EMPTY, {
      pendingActs: [],
      digest: digest(),
      now: new Date("2026-07-11T05:30:00"),
    });
    expect(early.notifications).toHaveLength(0);

    const morning = decideNotifications(early.next, {
      pendingActs: [],
      digest: digest(),
      now: new Date("2026-07-11T07:30:00"),
    });
    expect(morning.notifications).toHaveLength(1);
    expect(morning.notifications[0]!.body).toMatch(/3 captured/);

    const again = decideNotifications(morning.next, {
      pendingActs: [],
      digest: digest(),
      now: new Date("2026-07-11T09:00:00"),
    });
    expect(again.notifications).toHaveLength(0);
  });

  it("skips the digest on an empty day", () => {
    const { notifications } = decideNotifications(EMPTY, {
      pendingActs: [],
      digest: digest({ captured: 0, became: 0, categorized: 0, needsHuman: 0 }),
      now: new Date("2026-07-11T08:00:00"),
    });
    expect(notifications).toHaveLength(0);
  });

  it("keeps the notified-id memory bounded", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, title: `T${i}` }));
    const { next } = decideNotifications(EMPTY, {
      pendingActs: many,
      digest: null,
      now: new Date("2026-07-11T10:00:00Z"),
    });
    expect(next.notifiedActIds.length).toBeLessThanOrEqual(200);
  });
});
