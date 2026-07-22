import {
  ApiError,
} from "../src/lib/api";
import {
  PERMISSION_MODES,
  POLL_INTERVAL_MS,
  formatAge,
  formatCost,
  formatTokenCount,
  formatUsageLine,
  isTerminal,
  makeSessionsApi,
  parseUsage,
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

  it("reviewPrs GETs the owner-tagged PR list (MC-R1/MC-R2)", async () => {
    const prs = [
      {
        owner: "market-clue",
        repo: "app",
        number: 90,
        title: "Add login flow",
        author: "ArsenLabovich",
        branch: "login-pages",
        updatedAt: "2026-07-20T10:00:00Z",
        additions: 7390,
        deletions: 2155,
      },
    ];
    const { impl, calls } = fakeFetch(200, prs);
    expect(await makeSessionsApi(BASE, TOKEN, impl).reviewPrs()).toEqual(prs);
    expect(calls[0].url).toBe("http://host:8787/reviews/prs");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("launchReview POSTs the pick and returns {sessionId} (MC-R1)", async () => {
    const { impl, calls } = fakeFetch(201, { sessionId: "2026-07-22-rev1" });
    const res = await makeSessionsApi(BASE, TOKEN, impl).launchReview({
      owner: "market-clue",
      repo: "platform",
      pr: 94,
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(res).toEqual({ sessionId: "2026-07-22-rev1" });
    expect(calls[0].url).toBe("http://host:8787/reviews");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      owner: "market-clue",
      repo: "platform",
      pr: 94,
      model: "claude-opus-4-8",
      effort: "high",
    });
  });

  it("launchReview surfaces the no-checkout 409 as ApiError with status", async () => {
    const { impl } = fakeFetch(409, { error: "no local checkout" });
    const attempt = makeSessionsApi(BASE, TOKEN, impl).launchReview({
      owner: "market-clue",
      repo: "data",
      pr: 1,
      model: "claude-sonnet-5",
    });
    await expect(attempt).rejects.toMatchObject({ kind: "http", status: 409 });
  });
});

describe("formatAge", () => {
  const now = new Date("2026-07-22T12:00:00Z");
  it("renders minutes, hours and days compactly", () => {
    expect(formatAge("2026-07-22T11:55:00Z", now)).toBe("5m");
    expect(formatAge("2026-07-22T09:00:00Z", now)).toBe("3h");
    expect(formatAge("2026-07-20T11:00:00Z", now)).toBe("2d");
  });
  it("clamps future or invalid timestamps to 0m", () => {
    expect(formatAge("2026-07-23T00:00:00Z", now)).toBe("0m");
    expect(formatAge("not-a-date", now)).toBe("0m");
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

describe("transcribe (BI-C6 prompt dictation)", () => {
  class RecordingFormData {
    parts: { name: string; value: unknown }[] = [];
    append(name: string, value: unknown) {
      this.parts.push({ name, value });
    }
  }

  it("POSTs the audio as multipart with the bearer token and returns {text}", async () => {
    const originalFormData = globalThis.FormData;
    (globalThis as Record<string, unknown>).FormData = RecordingFormData;
    try {
      const { impl, calls } = fakeFetch(200, { text: "add voice input" });
      const res = await makeSessionsApi(BASE, TOKEN, impl).transcribe({
        uri: "file:///recordings/dictation.m4a",
        name: "dictation.m4a",
        ext: "m4a",
      });
      expect(res).toEqual({ text: "add voice input" });
      expect(calls[0].url).toBe("http://host:8787/sessions/transcribe");
      expect(calls[0].init.method).toBe("POST");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
      const body = calls[0].init.body as unknown as RecordingFormData;
      expect(body.parts).toEqual([
        {
          name: "file",
          value: { uri: "file:///recordings/dictation.m4a", name: "dictation.m4a", type: "audio/m4a" },
        },
      ]);
    } finally {
      (globalThis as Record<string, unknown>).FormData = originalFormData;
    }
  });

  it("surfaces the 503 WHISPER_CMD-unset answer as an ApiError with the status", async () => {
    const originalFormData = globalThis.FormData;
    (globalThis as Record<string, unknown>).FormData = RecordingFormData;
    try {
      const { impl } = fakeFetch(503, { error: "transcription unavailable" });
      const err = await makeSessionsApi(BASE, TOKEN, impl)
        .transcribe({ uri: "file:///d.m4a", name: "d.m4a", ext: "m4a" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
    } finally {
      (globalThis as Record<string, unknown>).FormData = originalFormData;
    }
  });
});

describe("usage formatting (BI-C5)", () => {
  it("parseUsage keeps only well-formed usage objects and defaults cache counters", () => {
    expect(
      parseUsage({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 }),
    ).toEqual({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 });
    expect(parseUsage({ input_tokens: 100, output_tokens: 20 })).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(parseUsage({ input_tokens: "lots", output_tokens: 20 })).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage("nope")).toBeNull();
  });

  it("formatTokenCount compacts to k/M and drops trailing .0", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(12345)).toBe("12.3k");
    expect(formatTokenCount(88000)).toBe("88k");
    expect(formatTokenCount(2_400_000)).toBe("2.4M");
  });

  it("formatCost keeps small runs visible with a third decimal", () => {
    expect(formatCost(0.4321)).toBe("$0.43");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0.004)).toBe("$0.004");
  });

  it("formatUsageLine joins tokens, cache and cost; null when there is nothing", () => {
    expect(
      formatUsageLine(
        { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 5000, cache_read_input_tokens: 88000 },
        0.4321,
      ),
    ).toBe("1.2k in · 340 out · 88k cached · $0.43");
    expect(
      formatUsageLine({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    ).toBe("100 in · 20 out");
    expect(formatUsageLine(undefined, 0.05)).toBe("$0.050");
    expect(formatUsageLine(undefined, undefined)).toBeNull();
  });
});
