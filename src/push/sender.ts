// BI-C3: Expo push sender. Plain fetch against the Expo push HTTP API — no
// SDK dependency; fetch is injected for tests. A send NEVER throws and NEVER
// blocks a session: zero registered tokens ⇒ silent no-op, transport or
// ticket errors ⇒ onError log only. `DeviceNotRegistered` tickets evict the
// dead token so the registry self-heals.
import type { PushTokenStore } from './tokens.js';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSenderConfig {
  tokens: PushTokenStore;
  fetchImpl?: typeof fetch;
  onError?: (err: unknown) => void;
}

interface PushTicket {
  status?: string;
  details?: { error?: string };
}

export class PushSender {
  private readonly tokens: PushTokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;

  constructor(config: PushSenderConfig) {
    this.tokens = config.tokens;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.onError = config.onError ?? ((): void => {});
  }

  /** One push to every registered device. Resolves on completion; never rejects. */
  async send(message: PushMessage): Promise<void> {
    const to = this.tokens.list();
    if (to.length === 0) return;

    try {
      const res = await this.fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(
          to.map((token) => ({
            to: token,
            title: message.title,
            body: message.body,
            sound: 'default',
            ...(message.data !== undefined ? { data: message.data } : {}),
          })),
        ),
      });
      if (!res.ok) {
        this.onError(new Error(`expo push API returned ${res.status}`));
        return;
      }
      const payload = (await res.json()) as { data?: PushTicket[] };
      const tickets = Array.isArray(payload.data) ? payload.data : [];
      tickets.forEach((ticket, i) => {
        if (ticket.status !== 'error') return;
        const token = to[i];
        if (ticket.details?.error === 'DeviceNotRegistered' && token !== undefined) {
          this.tokens.remove(token);
        } else {
          this.onError(new Error(`expo push ticket error: ${ticket.details?.error ?? 'unknown'}`));
        }
      });
    } catch (err) {
      this.onError(err);
    }
  }
}
