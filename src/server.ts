import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createItem, itemState, readEvents, type InboxEvent } from './inbox.js';

export interface ServerConfig {
  brainRoot: string;
}

const JSON_SOURCES = ['text', 'share-sheet'] as const;

const postItemSchema = {
  body: {
    type: 'object',
    required: ['source', 'text'],
    properties: {
      source: { type: 'string', enum: [...JSON_SOURCES] },
      text: { type: 'string', minLength: 1 },
      originalName: { type: 'string' },
      deviceTs: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const;

interface PostItemBody {
  source: (typeof JSON_SOURCES)[number];
  text: string;
  originalName?: string;
  deviceTs?: string;
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

  app.get('/health', async () => ({ ok: true, brainRoot: config.brainRoot }));

  app.post<{ Body: PostItemBody }>('/items', { schema: postItemSchema }, async (req, reply) => {
    const { source, text, originalName, deviceTs } = req.body;
    const result = createItem(inboxDir, Buffer.from(text, 'utf-8'), {
      source,
      ext: 'md',
      ...(originalName !== undefined ? { originalName } : {}),
      ...(deviceTs !== undefined ? { deviceTs } : {}),
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
