import { ApiError, makeApi } from "../src/lib/api";

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

class RecordingFormData {
  parts: { name: string; value: unknown }[] = [];
  append(name: string, value: unknown) {
    this.parts.push({ name, value });
  }
}

describe("makeApi", () => {
  it("health() GETs /health and returns the body", async () => {
    const { impl, calls } = fakeFetch(200, { ok: true, brainRoot: "/brain" });
    const api = makeApi("http://host:8787", impl);
    const res = await api.health();
    expect(res).toEqual({ ok: true, brainRoot: "/brain" });
    expect(calls[0].url).toBe("http://host:8787/health");
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const { impl, calls } = fakeFetch(200, { ok: true, brainRoot: "/brain" });
    await makeApi("http://host:8787/", impl).health();
    expect(calls[0].url).toBe("http://host:8787/health");
  });

  it("createText POSTs JSON with source/text/deviceTs and returns id+deduped", async () => {
    const { impl, calls } = fakeFetch(201, { id: "2026-07-08-abcd1234", deduped: false });
    const api = makeApi("http://host:8787", impl);
    const res = await api.createText({
      source: "share-sheet",
      text: "https://example.com",
      deviceTs: "2026-07-08T10:00:00Z",
    });
    expect(res).toEqual({ id: "2026-07-08-abcd1234", deduped: false });
    expect(calls[0].url).toBe("http://host:8787/items");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      source: "share-sheet",
      text: "https://example.com",
      deviceTs: "2026-07-08T10:00:00Z",
    });
  });

  it("createText omits deviceTs when not provided", async () => {
    const { impl, calls } = fakeFetch(201, { id: "x", deduped: false });
    await makeApi("http://host:8787", impl).createText({ source: "text", text: "hi" });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ source: "text", text: "hi" });
  });

  it("createFile POSTs multipart with a file part and source field", async () => {
    const originalFormData = globalThis.FormData;
    (globalThis as Record<string, unknown>).FormData = RecordingFormData;
    try {
      const { impl, calls } = fakeFetch(201, { id: "y", deduped: true });
      const api = makeApi("http://host:8787", impl);
      const res = await api.createFile({
        source: "photo",
        uri: "file:///tmp/p.jpg",
        name: "p.jpg",
        ext: "jpg",
        deviceTs: "2026-07-08T10:00:00Z",
      });
      expect(res).toEqual({ id: "y", deduped: true });
      const body = calls[0].init.body as unknown as RecordingFormData;
      expect(body.parts).toEqual([
        { name: "source", value: "photo" },
        { name: "deviceTs", value: "2026-07-08T10:00:00Z" },
        {
          name: "file",
          value: { uri: "file:///tmp/p.jpg", name: "p.jpg", type: "image/jpeg" },
        },
      ]);
      expect(calls[0].init.headers).toBeUndefined();
    } finally {
      (globalThis as Record<string, unknown>).FormData = originalFormData;
    }
  });

  it("listItems GETs /items", async () => {
    const items = [{ id: "a", state: "open", lastEvent: "queued" }];
    const { impl, calls } = fakeFetch(200, items);
    const res = await makeApi("http://host:8787", impl).listItems();
    expect(res).toEqual(items);
    expect(calls[0].url).toBe("http://host:8787/items");
  });

  it("itemDetail GETs /items/:id", async () => {
    const detail = {
      id: "a",
      state: "became",
      events: [{ ts: "t", event: "captured" }],
      payload: { name: "payload.md", bytes: 5 },
    };
    const { impl, calls } = fakeFetch(200, detail);
    const res = await makeApi("http://host:8787", impl).itemDetail("a");
    expect(res).toEqual(detail);
    expect(calls[0].url).toBe("http://host:8787/items/a");
  });

  it("maps non-2xx to ApiError kind=http with status", async () => {
    const { impl } = fakeFetch(404, { error: "unknown item" });
    const err = await makeApi("http://host:8787", impl)
      .itemDetail("nope")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("http");
    expect((err as ApiError).status).toBe(404);
  });

  it("maps fetch rejection to ApiError kind=unreachable", async () => {
    const impl = (async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    const err = await makeApi("http://host:8787", impl)
      .health()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unreachable");
  });

  it("passes an AbortSignal for timeouts", async () => {
    const { impl, calls } = fakeFetch(200, { ok: true, brainRoot: "/b" });
    await makeApi("http://host:8787", impl).health();
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("timeouts", () => {
  it("aborts JSON requests at 5s but keeps file uploads alive past it", async () => {
    jest.useFakeTimers();
    try {
      const impl = ((url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch;
      const api = makeApi("http://host:8787", impl);

      const health = api.health().catch((e: unknown) => e);
      const upload = api
        .createFile({ source: "photo", uri: "file:///p.heic", name: "p.heic", ext: "heic" })
        .catch((e: unknown) => e);

      jest.advanceTimersByTime(6_000);
      const healthErr = await health;
      expect(healthErr).toBeInstanceOf(ApiError);
      expect((healthErr as ApiError).kind).toBe("unreachable");

      let uploadSettled = false;
      void upload.then(() => (uploadSettled = true));
      await Promise.resolve();
      expect(uploadSettled).toBe(false); // still in flight at 6s

      jest.advanceTimersByTime(120_000);
      const uploadErr = await upload;
      expect(uploadErr).toBeInstanceOf(ApiError); // aborts only at its own 120s
    } finally {
      jest.useRealTimers();
    }
  });
});
