import type { Digest } from "../src/lib/api";
import { decideNotifications, type NotifyState } from "../src/lib/notify";

const EMPTY: NotifyState = { notifiedActIds: [], digestDate: null, loopReportId: null };

function digest(over: Partial<Digest["counts"]> = {}, loop: Digest["loop"] = null): Digest {
  return {
    date: "2026-07-11",
    counts: { captured: 3, became: 1, categorized: 1, needsHuman: 1, cloudApprovals: 0, ...over },
    highlights: [],
    loopDisabled: false,
    lastReport: "2026-07-11-richsmon.md",
    loop,
  };
}

const BUSY_LOOP: NonNullable<Digest["loop"]> = {
  reportId: "2026-07-19-richsmon.md",
  mode: "live",
  openItems: 5,
  openPrsBefore: 1,
  selected: 4,
  questions: 2,
  claimed: 2,
  skipped: 0,
  prsOpened: 2,
  errors: 0,
};

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

describe("loop-run notification (IN-6)", () => {
  const NIGHT = new Date("2026-07-19T03:00:00");

  it("adopts the first seen report silently — no historic spam on install", () => {
    const { notifications, next } = decideNotifications(EMPTY, {
      pendingActs: [],
      digest: digest({ captured: 0, became: 0, categorized: 0, needsHuman: 0 }, BUSY_LOOP),
      now: NIGHT,
    });
    expect(notifications).toHaveLength(0);
    expect(next.loopReportId).toBe("2026-07-19-richsmon.md");
  });

  it("notifies once when a NEW report appears, in human words", () => {
    const prev: NotifyState = { ...EMPTY, loopReportId: "2026-07-18-richsmon.md" };
    const { notifications, next } = decideNotifications(prev, {
      pendingActs: [],
      digest: digest({ captured: 0, became: 0, categorized: 0, needsHuman: 0 }, BUSY_LOOP),
      now: NIGHT,
    });
    const loopNote = notifications.find((n) => n.title === "Brain loop ran");
    expect(loopNote).toBeDefined();
    expect(loopNote!.body).toContain("2 PRs await review");
    expect(loopNote!.body).toContain("2 questions need you");
    expect(next.loopReportId).toBe("2026-07-19-richsmon.md");
    // same report again → silence
    const again = decideNotifications(next, {
      pendingActs: [],
      digest: digest({ captured: 0, became: 0, categorized: 0, needsHuman: 0 }, BUSY_LOOP),
      now: NIGHT,
    });
    expect(again.notifications).toHaveLength(0);
  });

  it("a quiet run says so instead of listing zeros; errors surface", () => {
    const prev: NotifyState = { ...EMPTY, loopReportId: "old.md" };
    const quiet = { ...BUSY_LOOP, prsOpened: 0, questions: 0, errors: 0 };
    const q = decideNotifications(prev, {
      pendingActs: [],
      digest: digest({ captured: 0, became: 0, categorized: 0, needsHuman: 0 }, quiet),
      now: NIGHT,
    });
    expect(q.notifications[0]!.body).toContain("Quiet run");

    const withErrors = { ...BUSY_LOOP, prsOpened: 0, questions: 1, errors: 3 };
    const e = decideNotifications(prev, {
      pendingActs: [],
      digest: digest({ captured: 0, became: 0, categorized: 0, needsHuman: 0 }, withErrors),
      now: NIGHT,
    });
    expect(e.notifications[0]!.body).toContain("1 question needs you");
    expect(e.notifications[0]!.body).toContain("3 errors");
  });
});
