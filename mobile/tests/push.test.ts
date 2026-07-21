const mockConstants: { expoConfig: { extra?: Record<string, unknown> } | null } = { expoConfig: null };
let mockLastResponse: unknown = null;
const mockRemove = jest.fn();
let mockResponseHandler: ((response: unknown) => void) | null = null;

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockConstants.expoConfig;
    },
  },
}));

jest.mock("expo-notifications", () => ({
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[real]" })),
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
  getEasProjectId,
  pathFromPushUrl,
  registerForSessionPush,
  subscribeToPushResponses,
  type PushRegistrationDeps,
} from "../src/lib/push";

function deps(over: Partial<PushRegistrationDeps> = {}): PushRegistrationDeps & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    getSessionsToken: async () => "sess-tok",
    getBaseUrl: async () => "http://host:8787/",
    getProjectId: () => "proj-123",
    requestPermission: async () => true,
    getExpoPushToken: async () => "ExponentPushToken[abc]",
    fetchImpl: (async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch,
    ...over,
  };
}

function pushResponse(url: unknown): unknown {
  return { notification: { request: { content: { data: { url } } } } };
}

describe("getEasProjectId", () => {
  it("is null until eas init has written extra.eas.projectId", () => {
    mockConstants.expoConfig = null;
    expect(getEasProjectId()).toBeNull();
    mockConstants.expoConfig = { extra: {} };
    expect(getEasProjectId()).toBeNull();
    mockConstants.expoConfig = { extra: { eas: { projectId: "" } } };
    expect(getEasProjectId()).toBeNull();
    mockConstants.expoConfig = { extra: { eas: { projectId: "11111111-2222-3333-4444-555555555555" } } };
    expect(getEasProjectId()).toBe("11111111-2222-3333-4444-555555555555");
  });
});

describe("registerForSessionPush", () => {
  it("registers the Expo push token with the server behind the sessions bearer", async () => {
    const d = deps();
    expect(await registerForSessionPush(d)).toBe("registered");
    expect(d.calls).toHaveLength(1);
    const [url, init] = d.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host:8787/push/register");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sess-tok");
    expect(JSON.parse(init.body as string)).toEqual({ token: "ExponentPushToken[abc]" });
  });

  it("is a graceful no-op without a sessions token — nothing else is touched", async () => {
    const permission = jest.fn(async () => true);
    const d = deps({ getSessionsToken: async () => "", requestPermission: permission });
    expect(await registerForSessionPush(d)).toBe("no-sessions-token");
    expect(permission).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  it("is a graceful no-op without an EAS projectId (pre eas-init state)", async () => {
    const d = deps({ getProjectId: () => null });
    expect(await registerForSessionPush(d)).toBe("no-project-id");
    expect(d.calls).toHaveLength(0);
  });

  it("is a graceful no-op when notification permission is denied", async () => {
    const getToken = jest.fn(async () => "x");
    const d = deps({ requestPermission: async () => false, getExpoPushToken: getToken });
    expect(await registerForSessionPush(d)).toBe("permission-denied");
    expect(getToken).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  it("never throws — token fetch or server errors come back as failed", async () => {
    expect(
      await registerForSessionPush(
        deps({
          getExpoPushToken: async () => {
            throw new Error("no APNs");
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

    mockResponseHandler!(pushResponse("brainer:///session/2026-07-22-abcd1234"));
    expect(navigate).toHaveBeenCalledWith("/session/2026-07-22-abcd1234");

    navigate.mockClear();
    mockResponseHandler!(pushResponse("brainer:///somewhere/else"));
    mockResponseHandler!({ notification: { request: { content: { data: undefined } } } });
    expect(navigate).not.toHaveBeenCalled();

    unsubscribe();
    expect(mockRemove).toHaveBeenCalled();
  });

  it("replays the response that cold-started the app", async () => {
    mockLastResponse = pushResponse("brainer:///session/2026-07-22-ffff0000");
    const navigate = jest.fn();
    subscribeToPushResponses(navigate);
    await Promise.resolve();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledWith("/session/2026-07-22-ffff0000");
  });
});
