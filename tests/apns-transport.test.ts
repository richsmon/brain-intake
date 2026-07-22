// BI-C7: the default HTTP/2 transport must SETTLE on every outcome. During the
// T-15 e2e the first gate push vanished with zero trace: the transport had no
// timeout (a stalled connection pends forever — nothing to log, nothing to
// retry) and resolved `{status: 0}` when the peer closed the stream without a
// response. These tests run the real transport against a local h2 server and
// pin down: every path either resolves with a real status or rejects.
import { createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2';
import { afterEach, describe, expect, test } from 'vitest';
import { makeHttp2Transport, type ApnsResponse } from '../src/push/apns.js';

let server: Http2Server | undefined;

async function listen(onStream: (stream: ServerHttp2Stream) => void): Promise<string> {
  server = createServer();
  server.on('stream', onStream);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('http2Transport settles on every outcome (BI-C7 silent-loss fix)', () => {
  test('resolves status + body on a normal response', async () => {
    const endpoint = await listen((stream) => {
      stream.respond({ ':status': 400 });
      stream.end('{"reason":"BadDeviceToken"}');
    });
    const res: ApnsResponse = await makeHttp2Transport()(endpoint, '/3/device/x', {}, '{}');
    expect(res.status).toBe(400);
    expect(res.body).toBe('{"reason":"BadDeviceToken"}');
  });

  test('rejects (never resolves status 0) when the peer closes the stream without a response', async () => {
    const endpoint = await listen((stream) => {
      stream.close(0); // NO_ERROR — the exact shape that used to resolve {status: 0}
    });
    await expect(makeHttp2Transport()(endpoint, '/3/device/x', {}, '{}')).rejects.toThrow(/without a response/);
  });

  test('rejects after the timeout when the connection stalls (used to pend forever)', async () => {
    const endpoint = await listen(() => {
      /* accept the stream, never respond */
    });
    await expect(makeHttp2Transport(150)(endpoint, '/3/device/x', {}, '{}')).rejects.toThrow(/timed out/);
  });
});
