import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createItem, itemState, readEvents, type InboxEvent } from './inbox.js';

export interface ServerConfig {
  brainRoot: string;
  /** Multipart file-size cap in bytes. Default 25 MB. */
  maxUploadBytes?: number;
}

const JSON_SOURCES = new Set(['text', 'share-sheet']);
const UPLOAD_SOURCES = new Set(['voice', 'photo']);
const UPLOAD_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'm4a', 'mp3', 'wav']);
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface PostItemBody {
  source: string;
  text: string;
  originalName?: string;
  deviceTs?: string;
}

function parseJsonBody(body: unknown): PostItemBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.source !== 'string' || !JSON_SOURCES.has(b.source)) return null;
  if (typeof b.text !== 'string' || b.text.length === 0) return null;
  if (b.originalName !== undefined && typeof b.originalName !== 'string') return null;
  if (b.deviceTs !== undefined && typeof b.deviceTs !== 'string') return null;
  return b as unknown as PostItemBody;
}

function multipartField(fields: unknown, name: string): string | undefined {
  const f = (fields as Record<string, unknown>)[name];
  const one = Array.isArray(f) ? f[0] : f;
  if (typeof one === 'object' && one !== null && 'value' in one) {
    const v = (one as { value: unknown }).value;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function itemDirs(inboxDir: string): string[] {
  return readdirSync(inboxDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive')
    .map((e) => e.name)
    .sort();
}

function lastClassifiedTitle(events: InboxEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === 'classified' && typeof e.title === 'string') return e.title;
  }
  return undefined;
}

export function buildServer(config: ServerConfig): FastifyInstance {
  const inboxDir = join(config.brainRoot, 'inbox');
  const app = Fastify();
  app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES },
  });

  app.get('/health', async () => ({ ok: true, brainRoot: config.brainRoot }));

  app.post('/items', async (req, reply) => {
    if (req.isMultipart()) {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'file part required' });

      const source = multipartField(data.fields, 'source');
      if (source === undefined || !UPLOAD_SOURCES.has(source)) {
        return reply.code(400).send({ error: 'multipart source must be voice or photo' });
      }
      const ext = extname(data.filename).slice(1).toLowerCase();
      if (!UPLOAD_EXTS.has(ext)) {
        return reply.code(400).send({ error: `extension not allowed: ${ext || '(none)'}` });
      }

      const deviceTs = multipartField(data.fields, 'deviceTs');
      const buf = await data.toBuffer(); // throws 413 over the fileSize limit
      const result = createItem(inboxDir, buf, {
        source,
        ext,
        originalName: data.filename,
        ...(deviceTs !== undefined ? { deviceTs } : {}),
      });
      return reply.code(201).send(result);
    }

    const body = parseJsonBody(req.body);
    if (body === null) {
      return reply.code(400).send({ error: 'expected {source: text|share-sheet, text, originalName?, deviceTs?}' });
    }
    const result = createItem(inboxDir, Buffer.from(body.text, 'utf-8'), {
      source: body.source,
      ext: 'md',
      ...(body.originalName !== undefined ? { originalName: body.originalName } : {}),
      ...(body.deviceTs !== undefined ? { deviceTs: body.deviceTs } : {}),
    });
    return reply.code(201).send(result);
  });

  app.get('/items', async () => {
    const out = [];
    for (const id of itemDirs(inboxDir)) {
      const events = readEvents(join(inboxDir, id));
      if (events.length === 0) continue;
      const title = lastClassifiedTitle(events);
      out.push({
        id,
        state: itemState(events),
        lastEvent: events[events.length - 1]!.event,
        ...(title !== undefined ? { title } : {}),
      });
    }
    return out;
  });

  app.get<{ Params: { id: string } }>('/items/:id', async (req, reply) => {
    const dir = join(inboxDir, req.params.id);
    const events = existsSync(dir) ? readEvents(dir) : [];
    if (events.length === 0) return reply.code(404).send({ error: 'unknown item' });

    const captured = events.find((e) => e.event === 'captured');
    const payloadName = typeof captured?.payload === 'string' ? captured.payload : undefined;
    const payload =
      payloadName !== undefined && existsSync(join(dir, payloadName))
        ? { name: payloadName, bytes: statSync(join(dir, payloadName)).size }
        : undefined;

    return {
      id: req.params.id,
      state: itemState(events),
      events,
      ...(payload !== undefined ? { payload } : {}),
    };
  });

  return app;
}
