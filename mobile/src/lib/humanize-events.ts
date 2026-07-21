// The audit trail, told in plain words. The protocol events stay untouched in
// events.jsonl — this maps them for humans at display time (same rule as the
// became→kind chip: translate at the presentation layer, never rename events).

import type { InboxEvent } from "./api";

export interface HumanEvent {
  /** Raw event name — drives the glyph/color via eventStateVisual. */
  event: string;
  /** Plain-words headline. */
  title: string;
  /** Optional second line with the interesting specifics. */
  detail?: string;
  /** Local HH:MM. */
  time: string;
}

const SOURCE_NOUN: Record<string, string> = {
  text: "Text note",
  voice: "Voice note",
  photo: "Photo",
  "share-sheet": "Shared link",
  "manual-drop": "Dropped file",
};

function localTime(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function humanize(e: InboxEvent, index: number, all: InboxEvent[]): HumanEvent | null {
  const time = localTime(e.ts);
  const base = { event: e.event, time };

  switch (e.event) {
    case "captured": {
      const noun = SOURCE_NOUN[str(e.source) ?? ""] ?? "Item";
      return { ...base, title: `${noun} captured` };
    }
    case "queued": {
      // The queued that immediately follows capture is plumbing — hide it.
      if (index > 0 && all[index - 1]?.event === "captured") return null;
      return { ...base, title: "Back in the queue", detail: "Waiting for the next pass" };
    }
    case "transcribed":
      return { ...base, title: "Transcribed on your Mac", detail: "Audio stays the source of truth" };
    case "kind-hint":
      return { ...base, title: `You marked it as ${str(e.kind) ?? "?"}` };
    case "cloud-requested":
      return { ...base, title: "You approved cloud analysis" };
    case "screened": {
      if (e.channel === "cloud") {
        return { ...base, title: "Sent to Claude", detail: "Only because you asked" };
      }
      return { ...base, title: "Privacy check passed", detail: "Everything stayed on your machine" };
    }
    case "classified": {
      const model = str(e.model);
      const cloud = e.classifier === "cloud";
      const who = cloud ? "Claude" : (model ?? "your local model");
      const labels = Array.isArray(e.labels) && e.labels.length > 0 ? ` · ${(e.labels as string[]).join(", ")}` : "";
      // "claude-default" is a placeholder, not provenance — only real ids earn a spot.
      const cloudModel = cloud && model && model !== "claude-default" ? ` · ${model}` : "";
      const took = typeof e.duration_ms === "number" ? ` · ${e.duration_ms < 1000 ? "<1 s" : `${Math.round(e.duration_ms / 1000)} s`}` : "";
      return {
        ...base,
        title: `Understood by ${who}`,
        detail: `${str(e.type) ?? "?"} in ${str(e.workspace) ?? "?"}${labels}${cloudModel}${took}`,
      };
    }
    case "routed":
      return { ...base, title: "Filed into the brain", detail: str(e.target) };
    case "became": {
      const kind = str(e.kind) ?? "artifact";
      const ws = str(e.artifact)?.match(/^workspaces\/([^/]+)\//)?.[1];
      return { ...base, title: `Became ${kind === "idea" ? "an" : "a"} ${kind}${ws ? ` in ${ws}` : ""}` };
    }
    case "categorized": {
      const labels = Array.isArray(e.labels) && e.labels.length > 0 ? ` · ${(e.labels as string[]).join(", ")}` : "";
      return {
        ...base,
        title: `Filed as a private ${str(e.kind) ?? "note"}${labels}`,
        detail: "Kept out of git by design",
      };
    }
    case "deferred":
      return { ...base, title: "Stored for you", detail: "Deliberately left unprocessed" };
    case "cloud-approval":
      return { ...base, title: "Needs your OK for cloud analysis", detail: str(e.reason) };
    case "needs-human":
      return { ...base, title: "Waiting for you", detail: str(e.reason) };
    default:
      return { ...base, title: e.event };
  }
}

export function humanizeTrail(events: InboxEvent[]): HumanEvent[] {
  const out: HumanEvent[] = [];
  events.forEach((e, i) => {
    const row = humanize(e, i, events);
    if (row) out.push(row);
  });
  return out;
}
