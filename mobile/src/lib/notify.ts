// Notification decisions — pure logic, no Expo imports, fully testable.
// v1 delivery is local notifications fired from a background fetch; when APNs
// lands (server-side push), the same decisions move server-side unchanged.

import type { Digest } from "./api";

export interface PendingAct {
  id: string;
  title: string;
}

export interface NotifyState {
  /** Act ids already notified about — never nag twice. Bounded. */
  notifiedActIds: string[];
  /** Local date (YYYY-MM-DD) of the last digest notification. */
  digestDate: string | null;
}

export interface NotificationContent {
  title: string;
  body: string;
}

const MAX_REMEMBERED = 200;
const DIGEST_HOUR = 7;

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function digestBody(digest: Digest): string {
  const { counts } = digest;
  const parts: string[] = [];
  if (counts.captured > 0) parts.push(`${counts.captured} captured yesterday and overnight`);
  const processed = counts.became + counts.categorized;
  if (processed > 0) parts.push(`${processed} processed`);
  const pending = counts.needsHuman + counts.cloudApprovals;
  if (pending > 0) parts.push(`${pending} waiting for you`);
  return parts.join(" · ") + ".";
}

export function decideNotifications(
  prev: NotifyState,
  snapshot: { pendingActs: PendingAct[]; digest: Digest | null; now: Date },
): { notifications: NotificationContent[]; next: NotifyState } {
  const notifications: NotificationContent[] = [];
  const known = new Set(prev.notifiedActIds);
  const fresh = snapshot.pendingActs.filter((act) => !known.has(act.id));

  if (fresh.length === 1) {
    notifications.push({
      title: "Brainer needs you",
      body: fresh[0]!.title,
    });
  } else if (fresh.length > 1) {
    notifications.push({
      title: "Brainer needs you",
      body: `${fresh.length} items are waiting in Act.`,
    });
  }

  let digestDate = prev.digestDate;
  const today = localDate(snapshot.now);
  if (
    snapshot.digest !== null &&
    digestDate !== today &&
    snapshot.now.getHours() >= DIGEST_HOUR
  ) {
    const c = snapshot.digest.counts;
    const hasContent = c.captured + c.became + c.categorized + c.needsHuman + c.cloudApprovals > 0;
    if (hasContent) {
      notifications.push({ title: "Morning digest", body: digestBody(snapshot.digest) });
      digestDate = today;
    }
  }

  const rememberedIds = [...prev.notifiedActIds, ...fresh.map((act) => act.id)].slice(
    -MAX_REMEMBERED,
  );

  return {
    notifications,
    next: { notifiedActIds: rememberedIds, digestDate },
  };
}
