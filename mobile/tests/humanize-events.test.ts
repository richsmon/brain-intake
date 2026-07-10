import type { InboxEvent } from "../src/lib/api";
import { humanizeTrail } from "../src/lib/humanize-events";

const T = "2026-07-10T18:12:44Z";

function trail(...events: Partial<InboxEvent>[]): InboxEvent[] {
  return events.map((e) => ({ ts: T, event: "queued", ...e }) as InboxEvent);
}

describe("humanizeTrail", () => {
  it("tells the story in plain words — no protocol nouns, no sha", () => {
    const rows = humanizeTrail(
      trail(
        { event: "captured", source: "voice", sha: "abcd1234", payload: "payload.m4a" },
        { event: "queued" },
        { event: "transcribed", transcript: "transcript.md" },
        { event: "screened", channel: "local", reason: "default-local" },
        { event: "classified", type: "task", workspace: "life", title: "Kúpiť mlieko", labels: ["nakupy"], classifier: "local", confidence: 0.95 },
        { event: "categorized", kind: "task", labels: ["nakupy"], workspace: "life" },
      ),
    );
    const text = rows.map((r) => `${r.title} ${r.detail ?? ""}`).join(" | ");
    expect(text).toContain("Voice note captured");
    expect(text).toContain("Transcribed on your Mac");
    expect(text).toContain("stayed on your machine");
    expect(text).toContain("task");
    expect(text).toContain("nakupy");
    expect(text).toContain("Filed as a private task");
    expect(text).not.toMatch(/sha|abcd1234|payload\.m4a/);
  });

  it("hides the boilerplate queued right after capture, keeps a meaningful re-queue", () => {
    const rows = humanizeTrail(
      trail(
        { event: "captured", source: "text" },
        { event: "queued" },
        { event: "cloud-approval", title: "X", reason: "confidence 0.4 < 0.6" },
        { event: "cloud-requested", via: "app-approve" },
        { event: "queued" },
      ),
    );
    const titles = rows.map((r) => r.title);
    expect(titles.filter((t) => t.includes("queue")).length).toBeLessThanOrEqual(1);
    expect(titles.join(" | ")).toContain("You approved cloud analysis");
    expect(titles.join(" | ")).toContain("Back in the queue");
  });

  it("describes the cloud path honestly", () => {
    const rows = humanizeTrail(
      trail(
        { event: "captured", source: "text" },
        { event: "screened", channel: "cloud", reason: "explicit @claude marker" },
        { event: "classified", type: "idea", workspace: "gotam", title: "Feed", labels: [], classifier: "cloud", confidence: 0.9 },
        { event: "routed", target: "workspaces/gotam/knowledge/feed.md" },
        { event: "became", artifact: "workspaces/gotam/knowledge/feed.md", kind: "idea" },
      ),
    );
    const text = rows.map((r) => `${r.title} ${r.detail ?? ""}`).join(" | ");
    expect(text).toContain("Sent to Claude");
    expect(text).toContain("you asked");
    expect(text).toContain("Became an idea in gotam");
  });

  it("formats times as local HH:MM", () => {
    const rows = humanizeTrail(trail({ event: "captured", source: "photo" }));
    expect(rows[0]!.time).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it("never crashes on unknown events — shows them raw as fallback", () => {
    const rows = humanizeTrail(trail({ event: "mystery-event" }));
    expect(rows[0]!.title).toBe("mystery-event");
  });
});
