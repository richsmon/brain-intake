// BI-C3 (direct APNs): push delivery straight to Apple — no Expo account, no
// relay service, zero new dependencies. Provider-token auth per Apple's spec
// (ES256 JWT via node:crypto), HTTP/2 via node:http2 (APNs speaks HTTP/2
// only; fetch cannot). The transport is injected for tests. One team-wide
// APNs auth key (.p8 from the Apple Developer portal, Keys → APNs) serves
// every app in the team. Decision:
// workspaces/brain-intake/decisions/2026-07-22-push-direct-apns-over-expo.md
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { connect } from 'node:http2';

export const APNS_PRODUCTION = 'https://api.push.apple.com';
/** Debug/dev builds register sandbox device tokens — point APNS_ENDPOINT here for those. */
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';

export interface ApnsKeyConfig {
  /** PEM contents of the .p8 APNs auth key (NOT the ASC API upload key). */
  privateKey: string;
  /** Key id from the portal (the 10-char suffix in AuthKey_XXXXXXXXXX.p8). */
  keyId: string;
  /** Apple Developer team id. */
  teamId: string;
  /** apns-topic = the app's bundle identifier. */
  topic: string;
  /** APNS_PRODUCTION (default) or APNS_SANDBOX. */
  endpoint?: string;
}

export interface ApnsResponse {
  status: number;
  body: string;
  /** `apns-id` response header — Apple's delivery id, quotable at their support. */
  apnsId?: string;
}

/** Test seam: one APNs HTTP/2 request. Default implementation below. */
export type ApnsTransport = (
  endpoint: string,
  path: string,
  headers: Record<string, string>,
  body: string,
) => Promise<ApnsResponse>;

/** APNs answers in well under a second; anything past this is a dead connection. */
export const APNS_TIMEOUT_MS = 10_000;

/**
 * Default transport factory: single HTTP/2 request per call, connection closed
 * after. BI-C7: the promise SETTLES on every outcome — the original version
 * had no timeout (a stalled connection pended forever, so a send could vanish
 * with zero trace) and resolved `{status: 0}` when the peer closed the stream
 * before responding. Now: timeout ⇒ reject, close-without-response ⇒ reject,
 * and a settled promise never re-settles.
 */
export function makeHttp2Transport(timeoutMs: number = APNS_TIMEOUT_MS): ApnsTransport {
  return (endpoint, path, headers, body) =>
    new Promise((resolve, reject) => {
      const session = connect(endpoint);
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        session.close();
      };
      const fail = (err: Error): void => settle(() => reject(err));
      const timer = setTimeout(() => {
        fail(new Error(`APNs request timed out after ${timeoutMs}ms`));
        session.destroy();
      }, timeoutMs);
      timer.unref(); // a pending push must never keep the process alive
      session.on('error', fail);
      const req = session.request({ ':method': 'POST', ':path': path, ...headers });
      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
        if (typeof h['apns-id'] === 'string') apnsId = h['apns-id'];
      });
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('error', fail);
      req.on('end', () => {
        if (status === 0) return; // stream ended with no response — 'close' rejects
        settle(() =>
          resolve({
            status,
            body: Buffer.concat(chunks).toString('utf-8'),
            ...(apnsId !== undefined ? { apnsId } : {}),
          }),
        );
      });
      req.on('close', () => {
        fail(new Error(`APNs stream closed without a response (rstCode ${req.rstCode})`));
      });
      req.end(body);
    });
}

export const http2Transport: ApnsTransport = makeHttp2Transport();

/** Apple requires provider tokens between 20 and 60 minutes old — refresh at 45. */
const JWT_MAX_AGE_MS = 45 * 60_000;

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

/** ES256 provider JWT per Apple's spec: {alg, kid} . {iss: teamId, iat}. */
export function makeProviderJwt(key: ApnsKeyConfig, nowMs: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: key.keyId }));
  const claims = b64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(nowMs / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(key.privateKey),
    dsaEncoding: 'ieee-p1363', // JOSE r||s signature form, not ASN.1
  });
  return `${signingInput}.${b64url(signature)}`;
}

export class ApnsClient {
  private readonly key: ApnsKeyConfig;
  private readonly transport: ApnsTransport;
  private readonly now: () => number;
  private jwt: { token: string; mintedAt: number } | null = null;

  constructor(key: ApnsKeyConfig, transport: ApnsTransport = http2Transport, now: () => number = Date.now) {
    this.key = key;
    this.transport = transport;
    this.now = now;
  }

  private providerJwt(): string {
    const nowMs = this.now();
    if (this.jwt === null || nowMs - this.jwt.mintedAt > JWT_MAX_AGE_MS) {
      this.jwt = { token: makeProviderJwt(this.key, nowMs), mintedAt: nowMs };
    }
    return this.jwt.token;
  }

  /** Deliver one alert notification to one device token. May throw (transport). */
  async deliver(deviceToken: string, payload: Record<string, unknown>): Promise<ApnsResponse> {
    return this.transport(
      this.key.endpoint ?? APNS_PRODUCTION,
      `/3/device/${deviceToken}`,
      {
        authorization: `bearer ${this.providerJwt()}`,
        'apns-topic': this.key.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      JSON.stringify(payload),
    );
  }
}
