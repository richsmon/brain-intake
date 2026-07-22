// BI-C3 (direct APNs): session push sender. Formats the alert payload and
// delivers to every registered device token via ApnsClient. A send NEVER
// throws and NEVER blocks a session: no client configured (no .p8 key yet) or
// zero registered tokens ⇒ silent no-op, transport errors ⇒ onError log only.
// APNs 410 `Unregistered` (and 400 `BadDeviceToken`) evict the dead token so
// the registry self-heals.
//
// Custom payload carries the deeplink twice — top-level `url` (direct-APNs
// convention, exposed via the notification trigger payload) AND `body: {url}`
// (the key expo-notifications maps into `request.content.data` on iOS) — so
// the app reads it regardless of expo-notifications version.
import type { ApnsClient } from './apns.js';
import type { PushTokenStore } from './tokens.js';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSenderConfig {
  tokens: PushTokenStore;
  /** Absent ⇒ push not configured ⇒ every send is a silent no-op. */
  client?: ApnsClient;
  onError?: (err: unknown) => void;
}

/** APNs alert payload for a session push. Exported for tests. */
export function apnsPayload(message: PushMessage): Record<string, unknown> {
  return {
    aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
    ...(message.data !== undefined ? { ...message.data, body: message.data } : {}),
  };
}

function isGoneToken(status: number, body: string): boolean {
  if (status === 410) return true;
  if (status !== 400) return false;
  try {
    return (JSON.parse(body) as { reason?: string }).reason === 'BadDeviceToken';
  } catch {
    return false;
  }
}

export class PushSender {
  private readonly tokens: PushTokenStore;
  private readonly client: ApnsClient | undefined;
  private readonly onError: (err: unknown) => void;

  constructor(config: PushSenderConfig) {
    this.tokens = config.tokens;
    this.client = config.client;
    this.onError = config.onError ?? ((): void => {});
  }

  /** One push to every registered device. Resolves on completion; never rejects. */
  async send(message: PushMessage): Promise<void> {
    if (this.client === undefined) return;
    const to = this.tokens.list();
    if (to.length === 0) return;

    const payload = apnsPayload(message);
    for (const deviceToken of to) {
      try {
        const res = await this.client.deliver(deviceToken, payload);
        if (res.status === 200) continue;
        if (isGoneToken(res.status, res.body)) {
          this.tokens.remove(deviceToken);
        } else {
          this.onError(new Error(`APNs ${res.status}: ${res.body || '(empty body)'}`));
        }
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
