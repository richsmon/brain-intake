import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError, type Api } from "../src/lib/api";
import { makeQueue, type QueueFs } from "../src/lib/queue";

const nodeFs: QueueFs = {
  async ensureDir(path) {
    await mkdir(path, { recursive: true });
  },
  async writeText(path, content) {
    await writeFile(path, content, "utf8");
  },
  async readText(path) {
    return readFile(path, "utf8");
  },
  async copy(src, dest) {
    await copyFile(src, dest);
  },
  async listDirs(path) {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  async exists(path) {
    return stat(path).then(
      () => true,
      () => false,
    );
  },
};

function recordingApi(overrides: Partial<Api> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const api = {
    health: async () => {
      calls.push({ method: "health", input: undefined });
      return { ok: true, brainRoot: "/brain" };
    },
    createText: async (input: unknown) => {
      calls.push({ method: "createText", input });
      return { id: "srv-1", deduped: false };
    },
    createFile: async (input: unknown) => {
      calls.push({ method: "createFile", input });
      return { id: "srv-2", deduped: false };
    },
    listItems: async () => [],
    itemDetail: async () => {
      throw new Error("not used");
    },
    ...overrides,
  } as unknown as Api;
  return { api, calls };
}

async function freshQueue() {
  const root = await mkdtemp(join(tmpdir(), "bi-queue-"));
  let n = 0;
  const queue = makeQueue({
    fs: nodeFs,
    dir: join(root, "queue"),
    newId: () => `id-${++n}`,
    now: () => "2026-07-08T12:00:00Z",
  });
  return { root, queue };
}

describe("makeQueue", () => {
  it("enqueue(text) creates an entry dir with meta.json + payload.md", async () => {
    const { root, queue } = await freshQueue();
    const id = await queue.enqueue({ kind: "text", source: "share-sheet", text: "https://x.com" });
    expect(id).toBe("id-1");
    const meta = JSON.parse(await readFile(join(root, "queue", "id-1", "meta.json"), "utf8"));
    expect(meta).toEqual({
      id: "id-1",
      kind: "text",
      source: "share-sheet",
      ext: "md",
      deviceTs: "2026-07-08T12:00:00Z",
      createdAt: "2026-07-08T12:00:00Z",
      tries: 0,
    });
    expect(await readFile(join(root, "queue", "id-1", "payload.md"), "utf8")).toBe("https://x.com");
  });

  it("enqueue(file) copies the source file into the entry", async () => {
    const { root, queue } = await freshQueue();
    const src = join(root, "photo.jpg");
    await writeFile(src, "JPEGDATA");
    await queue.enqueue({
      kind: "file",
      source: "photo",
      sourceUri: src,
      originalName: "IMG_1.jpg",
      ext: "jpg",
    });
    const meta = JSON.parse(await readFile(join(root, "queue", "id-1", "meta.json"), "utf8"));
    expect(meta.kind).toBe("file");
    expect(meta.source).toBe("photo");
    expect(meta.ext).toBe("jpg");
    expect(meta.originalName).toBe("IMG_1.jpg");
    expect(await readFile(join(root, "queue", "id-1", "payload.jpg"), "utf8")).toBe("JPEGDATA");
  });

  it("pending() lists entries oldest-first", async () => {
    const { queue } = await freshQueue();
    await queue.enqueue({ kind: "text", source: "text", text: "a" });
    await queue.enqueue({ kind: "text", source: "text", text: "b" });
    const entries = await queue.pending();
    expect(entries.map((e) => e.id)).toEqual(["id-1", "id-2"]);
    expect(entries[0].source).toBe("text");
  });

  it("flush() sends every entry and removes it on success", async () => {
    const { root, queue } = await freshQueue();
    await queue.enqueue({ kind: "text", source: "text", text: "note" });
    const src = join(root, "v.m4a");
    await writeFile(src, "AUDIO");
    await queue.enqueue({ kind: "file", source: "voice", sourceUri: src, ext: "m4a" });

    const { api, calls } = recordingApi();
    const report = await queue.flush(api);

    expect(report).toEqual({ sent: 2, left: 0 });
    expect(calls.map((c) => c.method)).toEqual(["health", "createText", "createFile"]);
    expect(calls[1].input).toEqual({
      source: "text",
      text: "note",
      deviceTs: "2026-07-08T12:00:00Z",
    });
    expect(calls[2].input).toEqual({
      source: "voice",
      uri: join(root, "queue", "id-2", "payload.m4a"),
      name: "payload.m4a",
      ext: "m4a",
      deviceTs: "2026-07-08T12:00:00Z",
    });
    expect(await queue.pending()).toEqual([]);
  });

  it("flush() short-circuits when health fails — no capture POSTs attempted", async () => {
    const { queue } = await freshQueue();
    await queue.enqueue({ kind: "text", source: "text", text: "note" });
    const { api, calls } = recordingApi({
      health: async () => {
        throw new ApiError("unreachable");
      },
    });
    const report = await queue.flush(api);
    expect(report).toEqual({ sent: 0, left: 1 });
    expect(calls).toEqual([]);
    expect((await queue.pending()).length).toBe(1);
  });

  it("flush() keeps a failing entry with tries++ and continues on http errors", async () => {
    const { root, queue } = await freshQueue();
    await queue.enqueue({ kind: "text", source: "text", text: "bad" });
    await queue.enqueue({ kind: "text", source: "text", text: "good" });
    const { api } = recordingApi({
      createText: async (input: { text: string }) => {
        if (input.text === "bad") throw new ApiError("http", 400);
        return { id: "srv", deduped: false };
      },
    });
    const report = await queue.flush(api);
    expect(report).toEqual({ sent: 1, left: 1 });
    const remaining = await queue.pending();
    expect(remaining.map((e) => e.id)).toEqual(["id-1"]);
    const meta = JSON.parse(await readFile(join(root, "queue", "id-1", "meta.json"), "utf8"));
    expect(meta.tries).toBe(1);
  });

  it("flush() stops early when a capture POST is unreachable — the rest stays queued untouched", async () => {
    const { queue } = await freshQueue();
    await queue.enqueue({ kind: "text", source: "text", text: "a" });
    await queue.enqueue({ kind: "text", source: "text", text: "b" });
    let attempts = 0;
    const { api } = recordingApi({
      createText: async () => {
        attempts++;
        throw new ApiError("unreachable");
      },
    });
    const report = await queue.flush(api);
    expect(attempts).toBe(1);
    expect(report).toEqual({ sent: 0, left: 2 });
  });

  it("re-flush after failure sends the remaining entries (idempotent by server dedupe)", async () => {
    const { queue } = await freshQueue();
    await queue.enqueue({ kind: "text", source: "text", text: "a" });
    const failing = recordingApi({
      createText: async () => {
        throw new ApiError("unreachable");
      },
    });
    await queue.flush(failing.api);
    const ok = recordingApi();
    const report = await queue.flush(ok.api);
    expect(report).toEqual({ sent: 1, left: 0 });
    expect(await queue.pending()).toEqual([]);
  });

  it("pending() on a nonexistent queue dir is an empty list", async () => {
    const { queue } = await freshQueue();
    expect(await queue.pending()).toEqual([]);
  });
});
