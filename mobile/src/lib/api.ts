// Typed client for the brain-host API (server half of IN-2).
// Contract mirror: brain-intake README endpoint table + inbox/README.md in the
// brain repo — field names here must never drift from the server.

export type TextSource = "text" | "share-sheet";
export type FileSource = "photo" | "voice";
export type FileExt = "jpg" | "jpeg" | "png" | "heic" | "m4a" | "mp3" | "wav";

export interface InboxEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface ItemSummary {
  id: string;
  state: string;
  lastEvent: string;
  title?: string;
}

export interface ItemDetail {
  id: string;
  state: string;
  events: InboxEvent[];
  payload: { name: string; bytes: number };
}

export interface CreateResult {
  id: string;
  deduped: boolean;
}

export interface Health {
  ok: boolean;
  brainRoot: string;
}

export class ApiError extends Error {
  readonly kind: "unreachable" | "http";
  readonly status?: number;

  constructor(kind: "unreachable" | "http", status?: number) {
    super(kind === "http" ? `API error: HTTP ${status}` : "API unreachable");
    this.kind = kind;
    this.status = status;
  }
}

const TIMEOUT_MS = 5000;
// Multipart uploads (photos are megabytes) need far longer than the snappy
// JSON timeout — a HEIC over the tailnet blew the 5s budget in build 2.
const UPLOAD_TIMEOUT_MS = 120_000;

export const MIME_BY_EXT: Record<FileExt, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  m4a: "audio/m4a",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function makeApi(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(
    path: string,
    init: Omit<RequestInit, "signal"> = {},
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal });
    } catch {
      throw new ApiError("unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new ApiError("http", res.status);
    }
    return (await res.json()) as T;
  }

  return {
    health(): Promise<Health> {
      return request<Health>("/health");
    },

    createText(input: { source: TextSource; text: string; deviceTs?: string }): Promise<CreateResult> {
      return request<CreateResult>("/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },

    createFile(input: {
      source: FileSource;
      uri: string;
      name: string;
      ext: FileExt;
      deviceTs?: string;
    }): Promise<CreateResult> {
      const form = new FormData();
      form.append("source", input.source);
      if (input.deviceTs !== undefined) {
        form.append("deviceTs", input.deviceTs);
      }
      // React Native FormData file part: {uri, name, type} object.
      form.append("file", {
        uri: input.uri,
        name: input.name,
        type: MIME_BY_EXT[input.ext],
      } as unknown as Blob);
      return request<CreateResult>("/items", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
    },

    listItems(): Promise<ItemSummary[]> {
      return request<ItemSummary[]>("/items");
    },

    itemDetail(id: string): Promise<ItemDetail> {
      return request<ItemDetail>(`/items/${encodeURIComponent(id)}`);
    },
  };
}

export type Api = ReturnType<typeof makeApi>;
