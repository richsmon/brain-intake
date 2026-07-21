// BI-C3: session-trail → push bridge. Subscribes to ALL store events and
// sends exactly one push per push-worthy event: a `permission_request` (a
// gate is waiting) and each terminal `status` (done / error / paused). Every
// push deep-links into the session detail via the app scheme — the same URL
// shape `Linking.createURL('/session/{id}')` produces in a standalone Expo
// app (`scheme:///path`), which expo-router resolves to the
// `session/[id]` route.
import type { PushMessage, PushSender } from './sender.js';
import type { SessionEvent, SessionStore } from '../sessions/store.js';

export const DEFAULT_SCHEME = 'brainer';

const TERMINAL_VERBS: Record<string, string> = {
  done: 'finished',
  error: 'failed',
  paused: 'paused — a gate timed out',
};

export function sessionDeepLink(id: string, scheme = DEFAULT_SCHEME): string {
  return `${scheme}:///session/${encodeURIComponent(id)}`;
}

function snippet(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Pure mapping: trail event → push (or null for the non-push-worthy rest). */
export function pushForEvent(
  event: SessionEvent,
  meta: { repo: string; prompt: string },
  url: string,
): PushMessage | null {
  if (event.event === 'permission_request') {
    const tool = typeof event.toolName === 'string' ? event.toolName : 'A tool';
    const detail =
      typeof event.command === 'string' ? event.command : typeof event.path === 'string' ? event.path : '';
    return {
      title: `${meta.repo}: approval needed`,
      body: detail ? `${tool} · ${snippet(detail)}` : `${tool} is waiting for your approval`,
      data: { url },
    };
  }
  if (event.event === 'status' && typeof event.status === 'string') {
    const verb = TERMINAL_VERBS[event.status];
    if (verb === undefined) return null;
    return {
      title: `${meta.repo}: ${event.status}`,
      body: `Session ${verb} — ${snippet(meta.prompt)}`,
      data: { url },
    };
  }
  return null;
}

export interface SessionPushConfig {
  store: SessionStore;
  sender: PushSender;
  scheme?: string;
}

/** Start forwarding push-worthy session events to the sender. Returns unwire. */
export function wireSessionPush(config: SessionPushConfig): () => void {
  const { store, sender } = config;
  const scheme = config.scheme ?? DEFAULT_SCHEME;
  return store.subscribeAll((id, event) => {
    // The first trail event carries the session meta (repo, prompt).
    const created = store.readEvents(id)[0];
    const meta = {
      repo: typeof created?.repo === 'string' ? created.repo : id,
      prompt: typeof created?.prompt === 'string' ? created.prompt : '',
    };
    const message = pushForEvent(event, meta, sessionDeepLink(id, scheme));
    if (message) void sender.send(message);
  });
}
