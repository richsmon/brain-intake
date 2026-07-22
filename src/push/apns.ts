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
}

/** Test seam: one APNs HTTP/2 request. Default implementation below. */
export type ApnsTransport = (
  endpoint: string,
  path: string,
  headers: Record<string, string>,
  body: string,
) => Promise<ApnsResponse>;

/** Default transport: single HTTP/2 request per call, connection closed after. */
export const http2Transport: ApnsTransport = (endpoint, path, headers, body) =>
  new Promise((resolve, reject) => {
    const session = connect(endpoint);
    session.on('error', reject);
    const req = session.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0;
    const chunks: Buffer[] = [];
    req.on('response', (h) => {
      status = Number(h[':status'] ?? 0);
    });
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', (err) => {
      session.close();
      reject(err);
    });
    req.on('end', () => {
      session.close();
      resolve({ status, body: Buffer.concat(chunks).toString('utf-8') });
    });
    req.end(body);
  });

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
