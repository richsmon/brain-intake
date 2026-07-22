// BI-C3 (direct APNs): push registration + notification deeplink routing.
//
// The server delivers straight to APNs, so the app registers its RAW device
// token (`getDevicePushTokenAsync`) — no Expo push service, no EAS project,
// no projectId. Registration is a graceful no-op unless the whole chain is
// available: sessions token configured (server mounts /push/register behind
// the same bearer guard as /sessions/*) and notification permission granted.
// Every early-out is a typed status so callers and tests can see exactly why
// nothing was registered. Decision:
// workspaces/brain-intake/decisions/2026-07-22-push-direct-apns-over-expo.md
//
// Deeplinks: the server puts `brainer:///session/{id}` (the
// `Linking.createURL` shape for a standalone app) BOTH at the payload top
// level (surfaced via the notification trigger payload) and under the `body`
// custom key (which expo-notifications maps into `request.content.data` on
// iOS). Tapping the notification routes to the expo-router `session/[id]`
// screen; the foreground banner is handled by the shared notification
// handler in notify-runtime.

import * as Notifications from "expo-notifications";
import { router } from "expo-router";

import { settings } from "./brain";

export type PushRegistrationStatus =
  | "registered"
  | "no-sessions-token"
  | "permission-denied"
  | "failed";

export interface PushRegistrationDeps {
  getSessionsToken(): Promise<string>;
  getBaseUrl(): Promise<string>;
  requestPermission(): Promise<boolean>;
  /** Raw APNs device token (hex string on iOS). Throws on simulators. */
  getDevicePushToken(): Promise<string>;
  fetchImpl: typeof fetch;
}

function realDeps(): PushRegistrationDeps {
  return {
    getSessionsToken: () => settings.getSessionsToken(),
    getBaseUrl: () => settings.getBaseUrl(),
    requestPermission: async () => (await Notifications.requestPermissionsAsync()).granted,
    getDevicePushToken: async () => {
      const token = await Notifications.getDevicePushTokenAsync();
      return typeof token.data === "string" ? token.data : JSON.stringify(token.data);
    },
    fetchImpl: fetch,
  };
}

/** Register this device for session pushes. Never throws — a missing link in
 * the chain returns its status and the app carries on without push. */
export async function registerForSessionPush(
  deps: PushRegistrationDeps = realDeps(),
): Promise<PushRegistrationStatus> {
  try {
    const sessionsToken = await deps.getSessionsToken();
    if (!sessionsToken) return "no-sessions-token";
    if (!(await deps.requestPermission())) return "permission-denied";
    const deviceToken = await deps.getDevicePushToken();
    const base = (await deps.getBaseUrl()).replace(/\/+$/, "");
    const res = await deps.fetchImpl(`${base}/push/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionsToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: deviceToken }),
    });
    return res.ok ? "registered" : "failed";
  } catch {
    return "failed";
  }
}

/** Parse the in-app route out of a push's deeplink url. Accepts both
 * `brainer:///session/x` and `brainer://session/x`; anything that is not a
 * session-detail link is ignored (null). */
export function pathFromPushUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(url);
  const path = match ? `/${match[1]!.replace(/^\/+/, "")}` : url.startsWith("/") ? url : null;
  if (path === null || !path.startsWith("/session/") || path === "/session/") return null;
  return path;
}

/** The deeplink may surface in content.data (expo mapping of the `body` key)
 * or in the raw APNs trigger payload (top-level `url` / `body.url`). */
export function urlFromNotification(response: Notifications.NotificationResponse | null): unknown {
  if (response === null) return null;
  const data = response.notification.request.content.data as Record<string, unknown> | undefined;
  if (typeof data?.url === "string") return data.url;
  const trigger = response.notification.request.trigger as { payload?: Record<string, unknown> } | null;
  const payload = trigger?.payload;
  if (typeof payload?.url === "string") return payload.url;
  const body = payload?.body as Record<string, unknown> | undefined;
  return body?.url ?? null;
}

function routeFromResponse(
  response: Notifications.NotificationResponse | null,
  navigate: (path: string) => void,
): void {
  const path = pathFromPushUrl(urlFromNotification(response));
  if (path !== null) navigate(path);
}

/** Route notification taps into the session detail. Also replays the response
 * that launched the app (cold start from a push). Returns unsubscribe. */
export function subscribeToPushResponses(
  navigate: (path: string) => void = (path) => router.push(path as never),
): () => void {
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => routeFromResponse(response, navigate))
    .catch(() => {});
  const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
    routeFromResponse(response, navigate),
  );
  return () => subscription.remove();
}
