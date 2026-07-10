// Expo glue for notify.ts: a background fetch polls the brain-host and fires
// LOCAL notifications from the pure decision logic. iOS schedules background
// runs opportunistically (~15 min floor, usage-based) — good enough until the
// server grows real APNs push; the decisions carry over unchanged.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";

import { getApi } from "./brain";
import { decideNotifications, type NotifyState, type PendingAct } from "./notify";

const TASK_NAME = "brainer-notify-poll";
const STATE_KEY = "brain.notifyState";

async function loadState(): Promise<NotifyState> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as NotifyState).notifiedActIds)) {
      return parsed as NotifyState;
    }
  } catch {
    // fall through to fresh state
  }
  return { notifiedActIds: [], digestDate: null };
}

/** One poll → decide → fire. Shared by the background task and app foregrounds. */
export async function runNotifyPass(): Promise<void> {
  let pendingActs: PendingAct[] = [];
  let digest = null;
  try {
    const api = await getApi();
    const [questions, cloudApprovals, dig] = await Promise.all([
      api.listQuestions().catch(() => []),
      api.listCloudApprovals().catch(() => []),
      api.digest().catch(() => null),
    ]);
    pendingActs = [
      ...questions.map((q) => ({ id: `q:${q.id}`, title: q.title })),
      ...cloudApprovals.map((c) => ({ id: `ca:${c.id}`, title: c.title })),
    ];
    digest = dig;
  } catch {
    return; // offline — nothing to decide
  }

  const prev = await loadState();
  const { notifications, next } = decideNotifications(prev, {
    pendingActs,
    digest,
    now: new Date(),
  });
  for (const content of notifications) {
    await Notifications.scheduleNotificationAsync({ content, trigger: null });
  }
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(next));
}

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    await runNotifyPass();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerNotifyTask(): Promise<void> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  try {
    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 });
  } catch {
    // Background tasks unavailable (simulator/older OS) — foreground passes still run.
  }
}
