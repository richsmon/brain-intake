// BI-C3 (direct APNs): session push sender. Formats the alert payload and
// delivers to every registered device token via ApnsClient. A send NEVER
// throws and NEVER blocks a session: no client configured (no .p8 key yet) or
// zero registered tokens ⇒ silent no-op, transport errors ⇒ reported, never
// thrown. APNs 410 `Unregistered` (and 400 `BadDeviceToken`) evict the dead
// token so the registry self-heals.
//
// BI-C7: every attempt is observable. onAttempt fires once per APNs request
// with the token suffix, apns-id and status/error (the server routes it to a
// console-backed log line — the T-15 e2e loss mode was a failure reported
// only through a disabled logger). The final outcome is persisted as the
// token's lastSend for GET /push/status. Network-class failures (transport
// rejection: timeout, socket, connect) get exactly one retry; an APNs HTTP
// verdict (4xx/5xx) is final — Apple answered, retrying won't change it.
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

/** One APNs request, reported through onAttempt. */
export interface PushSendAttempt {
  /** Last 8 chars of the device token — enough to correlate, never the token. */
  tokenSuffix: string;
  /** 1 on the first try, 2 on the single network-error retry. */
  attempt: number;
  ok: boolean;
  /** APNs HTTP status when Apple answered. */
  status?: number;
  /** `apns-id` response header when present. */
  apnsId?: string;
  /** Error class + message when the transport rejected. */
  error?: string;
}

export interface PushSenderConfig {
  tokens: PushTokenStore;
  /** Absent ⇒ push not configured ⇒ every send is a silent no-op. */
  client?: ApnsClient;
  /** BI-C7: fires once per APNs request — success AND failure. */
  onAttempt?: (attempt: PushSendAttempt) => void;
  onError?: (err: unknown) => void;
}

/** APNs alert payload for a session push. Exported for tests. */
export function apnsPayload(message: PushMessage): Record<string, unknown> {
  return {
    aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
    ...(message.data !== undefined ? { ...message.data, body: message.data } : {}),
  };
}

/** One concise log line per attempt — the server writes this to the launchd log. */
export function formatAttempt(a: PushSendAttempt): string {
  const parts = [`[push] …${a.tokenSuffix}`, `attempt ${a.attempt}`, a.ok ? 'ok' : 'FAIL'];
  if (a.status !== undefined) parts.push(`status=${a.status}`);
  if (a.apnsId !== undefined) parts.push(`apns-id=${a.apnsId}`);
  if (a.error !== undefined) parts.push(a.error);
  return parts.join(' ');
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

function errorLabel(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export class PushSender {
  private readonly tokens: PushTokenStore;
  private readonly client: ApnsClient | undefined;
  private readonly onAttempt: (attempt: PushSendAttempt) => void;
  private readonly onError: (err: unknown) => void;

  constructor(config: PushSenderConfig) {
    this.tokens = config.tokens;
    this.client = config.client;
    this.onAttempt = config.onAttempt ?? ((): void => {});
    this.onError = config.onError ?? ((): void => {});
  }

  /** One push to every registered device. Resolves on completion; never rejects. */
  async send(message: PushMessage): Promise<void> {
    if (this.client === undefined) return;
    const to = this.tokens.list();
    if (to.length === 0) return;

    const payload = apnsPayload(message);
    for (const deviceToken of to) {
      await this.sendOne(this.client, deviceToken, payload);
    }
  }

  /** Delivery to one token: at most two attempts, outcome always recorded. */
  private async sendOne(
    client: ApnsClient,
    deviceToken: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tokenSuffix = deviceToken.slice(-8);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await client.deliver(deviceToken, payload);
        this.onAttempt({
          tokenSuffix,
          attempt,
          ok: res.status === 200,
          status: res.status,
          ...(res.apnsId !== undefined ? { apnsId: res.apnsId } : {}),
        });
        if (res.status === 200) {
          this.tokens.recordSend(deviceToken, { ts: new Date().toISOString(), ok: true, status: 200 });
        } else if (isGoneToken(res.status, res.body)) {
          this.tokens.remove(deviceToken);
        } else {
          this.tokens.recordSend(deviceToken, { ts: new Date().toISOString(), ok: false, status: res.status });
          this.onError(new Error(`APNs ${res.status}: ${res.body || '(empty body)'}`));
        }
        return; // Apple answered — the verdict is final, never retry it.
      } catch (err) {
        const error = errorLabel(err);
        this.onAttempt({ tokenSuffix, attempt, ok: false, error });
        this.onError(err);
        if (attempt === 2) {
          this.tokens.recordSend(deviceToken, { ts: new Date().toISOString(), ok: false, error });
        }
        // Network-class failure — loop once more for the single retry.
      }
    }
  }
}
