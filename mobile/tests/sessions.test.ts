import {
  ApiError,
} from "../src/lib/api";
import {
  PERMISSION_MODES,
  POLL_INTERVAL_MS,
  isTerminal,
  makeSessionsApi,
  permissionModeLabel,
  startEventsPoll,
  type EventsPage,
} from "../src/lib/sessions";

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = "http://host:8787";
const TOKEN = "tok-123";

describe("makeSessionsApi", () => {
  it("sends the bearer token on every request", async () => {
    const { impl, calls } = fakeFetch(200, []);
    await makeSessionsApi(BASE, TOKEN, impl).list();
    expect(calls[0].url).toBe("http://host:8787/sessions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("create POSTs the session spec and returns {id}", async () => {
    const { impl, calls } = fakeFetch(201, { id: "2026-07-22-abcd1234" });
    const api = makeSessionsApi(BASE, TOKEN, impl);
    const res = await api.create({
      repo: "gotam",
      prompt: "fix login",
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "gated",
    });
    expect(res).toEqual({ id: "2026-07-22-abcd1234" });
    expect(calls[0].url).toBe("http://host:8787/sessions");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      repo: "gotam",
      prompt: "fix login",
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "gated",
    });
  });

  it("meta GETs /sessions/meta — the single source for the pickers", async () => {
    const meta = { repos: ["gotam"], models: [{ id: "claude-sonnet-5", label: "Sonnet" }], efforts: ["high"] };
    const { impl, calls } = fakeFetch(200, meta);
    expect(await makeSessionsApi(BASE, TOKEN, impl).meta()).toEqual(meta);
    expect(calls[0].url).toBe("http://host:8787/sessions/meta");
  });

  it("events GETs the poll snapshot with the offset in the query string", async () => {
    const page: EventsPage = { events: [], nextOffset: 7, state: "running" };
    const { impl, calls } = fakeFetch(200, page);
    expect(await makeSessionsApi(BASE, TOKEN, impl).events("s1", 7)).toEqual(page);
    expect(calls[0].url).toBe("http://host:8787/sessions/s1/events.json?offset=7");
  });

  it("approve / deny / mode / message POST to the session action routes", async () => {
    const { impl, calls } = fakeFetch(200, { ok: true });
    const api = makeSessionsApi(BASE, TOKEN, impl);
    await api.approve("s1", "r1");
    await api.deny("s1", "r2", "no thanks");
    await api.setMode("s1", "auto");
    await api.sendMessage("s1", "keep going");
    expect(calls.map((c) => c.url)).toEqual([
      "http://host:8787/sessions/s1/approve",
      "http://host:8787/sessions/s1/deny",
      "http://host:8787/sessions/s1/mode",
      "http://host:8787/sessions/s1/message",
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ requestId: "r1" });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ requestId: "r2", message: "no thanks" });
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ mode: "auto" });
    expect(JSON.parse(calls[3].init.body as string)).toEqual({ text: "keep going" });
  });

  it("maps HTTP failures to ApiError", async () => {
    const { impl } = fakeFetch(401, { error: "unauthorized" });
    await expect(makeSessionsApi(BASE, "wrong", impl).list()).rejects.toThrow(ApiError);
  });
});

describe("permission modes (BI-C4)", () => {
  it("offers the three modes with gated first (the default) and labels each", () => {
    expect(PERMISSION_MODES).toEqual(["gated", "acceptEdits", "auto"]);
    expect(permissionModeLabel("gated")).toBe("gated (approve edits)");
    expect(permissionModeLabel("acceptEdits")).toBe("acceptEdits");
    expect(permissionModeLabel("auto")).toBe("auto (no gates)");
  });
});

describe("isTerminal", () => {
  it("done/error/paused are terminal; running/waiting are not", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("paused")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("waiting-approval")).toBe(false);
    expect(isTerminal("created")).toBe(false);
  });
});

describe("startEventsPoll", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function pagedApi(pages: EventsPage[]) {
    const offsets: number[] = [];
    let i = 0;
    return {
      offsets,
      events: async (_id: string, offset: number) => {
        offsets.push(offset);
        const page = pages[Math.min(i, pages.length - 1)];
        i += 1;
        return page;
      },
    };
  }

  async function flush() {
    // Let pending promise callbacks run before advancing timers.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("polls with advancing offsets every interval and stops on a terminal state", async () => {
    const api = pagedApi([
      { events: [{ index: 0, event: "status" }], nextOffset: 1, state: "running" },
      { events: [{ index: 1, event: "chat_chunk" }], nextOffset: 2, state: "running" },
      { events: [{ index: 2, event: "status" }], nextOffset: 3, state: "done" },
    ]);
    const seen: EventsPage[] = [];
    startEventsPoll(api, "s1", (p) => seen.push(p), {});

    await flush();
    expect(api.offsets).toEqual([0]);

    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    await flush();
    expect(api.offsets).toEqual([0, 1]);

    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    await flush();
    expect(api.offsets).toEqual([0, 1, 2]);
    expect(seen).toHaveLength(3);
    expect(seen[2].state).toBe("done");

    // Terminal — no further polls no matter how long we wait.
    jest.advanceTimersByTime(POLL_INTERVAL_MS * 10);
    await flush();
    expect(api.offsets).toEqual([0, 1, 2]);
  });

  it("keeps polling through transient errors without losing the offset", async () => {
    let fail = true;
    const offsets: number[] = [];
    const api = {
      events: async (_id: string, offset: number): Promise<EventsPage> => {
        offsets.push(offset);
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
        return { events: [], nextOffset: offset, state: "running" };
      },
    };
    const seen: EventsPage[] = [];
    startEventsPoll(api, "s1", (p) => seen.push(p), { fromOffset: 4 });

    await flush();
    expect(offsets).toEqual([4]);
    expect(seen).toHaveLength(0);

    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    await flush();
    expect(offsets).toEqual([4, 4]);
    expect(seen).toHaveLength(1);
  });

  it("the stop function halts the loop immediately", async () => {
    const api = pagedApi([{ events: [], nextOffset: 0, state: "running" }]);
    const stop = startEventsPoll(api, "s1", () => {}, {});
    await flush();
    expect(api.offsets).toEqual([0]);
    stop();
    jest.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    await flush();
    expect(api.offsets).toEqual([0]);
  });
});
