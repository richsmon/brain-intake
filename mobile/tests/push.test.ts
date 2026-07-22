let mockLastResponse: unknown = null;
const mockRemove = jest.fn();
let mockResponseHandler: ((response: unknown) => void) | null = null;

jest.mock("expo-notifications", () => ({
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: "ios", data: "abcdef0123456789" })),
  getLastNotificationResponseAsync: jest.fn(async () => mockLastResponse),
  addNotificationResponseReceivedListener: jest.fn((handler: (response: unknown) => void) => {
    mockResponseHandler = handler;
    return { remove: mockRemove };
  }),
}));

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
}));

jest.mock("../src/lib/brain", () => ({
  settings: {
    getSessionsToken: jest.fn(async () => "tok"),
    getBaseUrl: jest.fn(async () => "http://host:8787"),
  },
}));

import {
  pathFromPushUrl,
  registerForSessionPush,
  subscribeToPushResponses,
  urlFromNotification,
  type PushRegistrationDeps,
} from "../src/lib/push";

function deps(over: Partial<PushRegistrationDeps> = {}): PushRegistrationDeps & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    getSessionsToken: async () => "sess-tok",
    getBaseUrl: async () => "http://host:8787/",
    requestPermission: async () => true,
    getDevicePushToken: async () => "aabbccddeeff0011",
    fetchImpl: (async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch,
    ...over,
  };
}

function dataResponse(url: unknown): unknown {
  return { notification: { request: { content: { data: { url } }, trigger: null } } };
}

function apnsResponse(payload: Record<string, unknown>): unknown {
  return { notification: { request: { content: { data: undefined }, trigger: { type: "push", payload } } } };
}

describe("registerForSessionPush", () => {
  it("registers the raw APNs device token with the server behind the sessions bearer", async () => {
    const d = deps();
    expect(await registerForSessionPush(d)).toBe("registered");
    expect(d.calls).toHaveLength(1);
    const [url, init] = d.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host:8787/push/register");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sess-tok");
    expect(JSON.parse(init.body as string)).toEqual({ token: "aabbccddeeff0011" });
  });

  it("is a graceful no-op without a sessions token — nothing else is touched", async () => {
    const permission = jest.fn(async () => true);
    const d = deps({ getSessionsToken: async () => "", requestPermission: permission });
    expect(await registerForSessionPush(d)).toBe("no-sessions-token");
    expect(permission).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  it("is a graceful no-op when notification permission is denied", async () => {
    const getToken = jest.fn(async () => "x");
    const d = deps({ requestPermission: async () => false, getDevicePushToken: getToken });
    expect(await registerForSessionPush(d)).toBe("permission-denied");
    expect(getToken).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  it("never throws — device-token errors (e.g. simulator) or server errors come back as failed", async () => {
    expect(
      await registerForSessionPush(
        deps({
          getDevicePushToken: async () => {
            throw new Error("no APNs on simulator");
          },
        }),
      ),
    ).toBe("failed");
    expect(
      await registerForSessionPush(
        deps({
          fetchImpl: (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
        }),
      ),
    ).toBe("failed");
  });
});

describe("pathFromPushUrl", () => {
  it("parses both standalone and bare scheme forms into the router path", () => {
    expect(pathFromPushUrl("brainer:///session/2026-07-22-abcd1234")).toBe("/session/2026-07-22-abcd1234");
    expect(pathFromPushUrl("brainer://session/2026-07-22-abcd1234")).toBe("/session/2026-07-22-abcd1234");
    expect(pathFromPushUrl("/session/2026-07-22-abcd1234")).toBe("/session/2026-07-22-abcd1234");
  });

  it("ignores anything that is not a session-detail link", () => {
    expect(pathFromPushUrl("brainer:///items")).toBeNull();
    expect(pathFromPushUrl("brainer:///session/")).toBeNull();
    expect(pathFromPushUrl("https://example.com/session/x")).toBeNull(); // web host is not an in-app path
    expect(pathFromPushUrl(undefined)).toBeNull();
    expect(pathFromPushUrl(42)).toBeNull();
  });
});

describe("urlFromNotification", () => {
  const URL = "brainer:///session/2026-07-22-abcd1234";

  it("reads content.data.url (expo-notifications mapping of the body key)", () => {
    expect(urlFromNotification(dataResponse(URL) as never)).toBe(URL);
  });

  it("falls back to the raw APNs trigger payload — top-level url, then body.url", () => {
    expect(urlFromNotification(apnsResponse({ url: URL }) as never)).toBe(URL);
    expect(urlFromNotification(apnsResponse({ body: { url: URL } }) as never)).toBe(URL);
    expect(urlFromNotification(apnsResponse({ aps: {} }) as never)).toBeNull();
    expect(urlFromNotification(null)).toBeNull();
  });
});

describe("subscribeToPushResponses", () => {
  beforeEach(() => {
    mockLastResponse = null;
    mockResponseHandler = null;
    mockRemove.mockClear();
  });

  it("routes a tapped push to the session detail and unsubscribes cleanly", async () => {
    const navigate = jest.fn();
    const unsubscribe = subscribeToPushResponses(navigate);
    await Promise.resolve(); // let the cold-start check settle (null → no route)
    expect(navigate).not.toHaveBeenCalled();

    mockResponseHandler!(dataResponse("brainer:///session/2026-07-22-abcd1234"));
    expect(navigate).toHaveBeenCalledWith("/session/2026-07-22-abcd1234");

    navigate.mockClear();
    mockResponseHandler!(apnsResponse({ url: "brainer:///session/2026-07-22-eeee1111" }));
    expect(navigate).toHaveBeenCalledWith("/session/2026-07-22-eeee1111");

    navigate.mockClear();
    mockResponseHandler!(dataResponse("brainer:///somewhere/else"));
    mockResponseHandler!({ notification: { request: { content: { data: undefined }, trigger: null } } });
    expect(navigate).not.toHaveBeenCalled();

    unsubscribe();
    expect(mockRemove).toHaveBeenCalled();
  });

  it("replays the response that cold-started the app", async () => {
    mockLastResponse = apnsResponse({ url: "brainer:///session/2026-07-22-ffff0000" });
    const navigate = jest.fn();
    subscribeToPushResponses(navigate);
    await Promise.resolve();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledWith("/session/2026-07-22-ffff0000");
  });
});
