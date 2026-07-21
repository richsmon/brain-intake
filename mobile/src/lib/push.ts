// BI-C3: Expo push registration + notification deeplink routing.
//
// Registration is a graceful no-op unless the whole chain is available:
// sessions token configured (server mounts /push/register behind the same
// bearer guard as /sessions/*), an EAS projectId in app config
// (`extra.eas.projectId` — requires the one-time `eas init`), and notification
// permission granted. Every early-out is a typed status so callers and tests
// can see exactly why nothing was registered.
//
// Deeplinks: the server pushes `data.url = brainer:///session/{id}` (the
// `Linking.createURL` shape for a standalone app). Tapping the notification
// routes to the expo-router `session/[id]` screen; the foreground banner is
// handled by the shared notification handler in notify-runtime.

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";

import { settings } from "./brain";

export type PushRegistrationStatus =
  | "registered"
  | "no-sessions-token"
  | "no-project-id"
  | "permission-denied"
  | "failed";

export interface PushRegistrationDeps {
  getSessionsToken(): Promise<string>;
  getBaseUrl(): Promise<string>;
  getProjectId(): string | null;
  requestPermission(): Promise<boolean>;
  getExpoPushToken(projectId: string): Promise<string>;
  fetchImpl: typeof fetch;
}

/** `extra.eas.projectId` from app config — null until `eas init` has run. */
export function getEasProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function realDeps(): PushRegistrationDeps {
  return {
    getSessionsToken: () => settings.getSessionsToken(),
    getBaseUrl: () => settings.getBaseUrl(),
    getProjectId: getEasProjectId,
    requestPermission: async () => (await Notifications.requestPermissionsAsync()).granted,
    getExpoPushToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
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
    const projectId = deps.getProjectId();
    if (projectId === null) return "no-project-id";
    if (!(await deps.requestPermission())) return "permission-denied";
    const pushToken = await deps.getExpoPushToken(projectId);
    const base = (await deps.getBaseUrl()).replace(/\/+$/, "");
    const res = await deps.fetchImpl(`${base}/push/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionsToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: pushToken }),
    });
    return res.ok ? "registered" : "failed";
  } catch {
    return "failed";
  }
}

/** Parse the in-app route out of a push's `data.url`. Accepts both
 * `brainer:///session/x` and `brainer://session/x`; anything that is not a
 * session-detail link is ignored (null). */
export function pathFromPushUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(url);
  const path = match ? `/${match[1]!.replace(/^\/+/, "")}` : url.startsWith("/") ? url : null;
  if (path === null || !path.startsWith("/session/") || path === "/session/") return null;
  return path;
}

function routeFromResponse(
  response: Notifications.NotificationResponse | null,
  navigate: (path: string) => void,
): void {
  const data = response?.notification.request.content.data as Record<string, unknown> | undefined;
  const path = pathFromPushUrl(data?.url);
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
