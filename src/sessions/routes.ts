// BI-C1: Fastify routes for the sessions module. Bearer-token guard identical
// in spirit to the live server's Tailscale+token posture — every sessions
// route requires `Authorization: Bearer <sessionsToken>`. Registered inside an
// encapsulated plugin so the guard hook applies only to /sessions/*.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SessionModel } from '../config.js';
import type { PushTokenStore } from '../push/tokens.js';
import { AUDIO_EXTS, transcribeAudio, type TranscribeDeps } from '../transcribe.js';
import type { SessionPermissionMode } from './runner.js';
import { sessionState, type SessionMeta, type SessionStore } from './store.js';
import { makeUsageSummary, type UsageSummary } from './usage.js';

export interface SessionRunnerLike {
  run(id: string, meta: SessionMeta, opts?: { model?: string; effort?: string; permissionMode?: SessionPermissionMode }): Promise<void>;
  approve(id: string, requestId: string): boolean;
  deny(id: string, requestId: string, message?: string): boolean;
  setMode(id: string, mode: SessionPermissionMode): Promise<boolean>;
  sendMessage(id: string, text: string): boolean;
}

export interface SessionRoutesConfig {
  store: SessionStore;
  runner: SessionRunnerLike;
  repoAllowlist: Record<string, string>;
  token: string;
  /** BI-C2: picker values for `GET /sessions/meta` — server config is the single source. */
  models: SessionModel[];
  efforts: string[];
  /** BI-C3: device push-token registry behind `POST /push/register`. Absent ⇒ route not mounted. */
  pushTokens?: PushTokenStore;
  /** BI-C7: whether an APNs client is wired — surfaced by `GET /push/status`. */
  pushConfigured?: boolean;
  /** BI-C6: dictation for prompt inputs — same WHISPER_CMD as the capture flow.
   * Unset ⇒ `POST /sessions/transcribe` answers 503 and the app falls back to typing. */
  whisperCmd?: string;
  /** Test seam for the whisper shell-out. */
  transcribeDeps?: TranscribeDeps;
  /** BI-C8: test seam for `GET /usage/summary`. Defaults to a 30 s-cached scan
   * of the store's sessionsDir. */
  usageSummary?: () => UsageSummary;
}

interface PostSessionBody {
  repo?: unknown;
  prompt?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
}

const MODES = new Set<string>(['gated', 'acceptEdits', 'auto'] satisfies SessionPermissionMode[]);

export function registerSessionRoutes(app: FastifyInstance, config: SessionRoutesConfig): void {
  const { store, runner, repoAllowlist, token, models, efforts, pushTokens, pushConfigured, whisperCmd, transcribeDeps } =
    config;
  // BI-C8: usage totals scan the store's own dir — the JSONLs ARE the ledger.
  const usageSummary = config.usageSummary ?? makeUsageSummary(store.dir);

  void app.register((scoped, _opts, done) => {
    scoped.addHook('onRequest', (req, reply, next) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      next();
    });

    scoped.post('/sessions', async (req, reply) => {
      const body = (req.body ?? {}) as PostSessionBody;
      const repo = typeof body.repo === 'string' ? body.repo : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt) return reply.code(400).send({ error: 'prompt required' });
      const repoPath = repoAllowlist[repo];
      if (repoPath === undefined) {
        return reply.code(400).send({ error: `unknown repo: ${repo || '(none)'}` });
      }
      const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5';
      const permissionMode: SessionPermissionMode =
        typeof body.permissionMode === 'string' && MODES.has(body.permissionMode)
          ? (body.permissionMode as SessionPermissionMode)
          : 'gated';
      const effort = typeof body.effort === 'string' ? body.effort : undefined;

      const meta: SessionMeta = {
        repo,
        repoPath,
        prompt,
        model,
        permissionMode,
        ...(effort !== undefined ? { effort } : {}),
      };
      const id = store.createSession(meta);
      // Fire-and-forget: the session runs independently of this request's lifecycle.
      void runner
        .run(id, meta, { model, permissionMode, ...(effort !== undefined ? { effort } : {}) })
        .catch(() => {
          store.appendEvent(id, { event: 'status', status: 'error' });
        });
      return reply.code(201).send({ id });
    });

    scoped.get('/sessions', async () => store.listSessions());

    // BI-C3: device registration for session pushes. Same bearer guard as the
    // rest of the plugin; dedupe lives in the token store.
    if (pushTokens !== undefined) {
      scoped.post<{ Body: { token?: unknown } }>('/push/register', async (req, reply) => {
        const pushToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        if (!pushToken) return reply.code(400).send({ error: 'token required' });
        const added = pushTokens.register(pushToken);
        return reply.code(added ? 201 : 200).send({ ok: true });
      });

      // BI-C7: delivery observability — per-token lastSend outcome, so "did the
      // push actually go out?" is answerable from the phone or a curl.
      scoped.get('/push/status', async () => ({
        configured: pushConfigured ?? false,
        tokens: pushTokens.entries().map((e) => ({
          suffix: e.token.slice(-8),
          ...(e.lastSend !== undefined ? { lastSend: e.lastSend } : {}),
        })),
      }));
    }

    // BI-C6: synchronous dictation — audio in, transcript out, nothing stored.
    // The capture flow's STT is fire-and-forget (transcript lands on the inbox
    // item's trail, never back at the phone); prompt dictation needs the text
    // in the response, so it gets its own request/response endpoint over the
    // same WHISPER_CMD machinery.
    scoped.post('/sessions/transcribe', async (req, reply) => {
      if (whisperCmd === undefined) {
        return reply.code(503).send({ error: 'transcription unavailable: WHISPER_CMD unset' });
      }
      if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart file required' });
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'file part required' });
      const ext = extname(data.filename).slice(1).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) {
        return reply.code(400).send({ error: `not an audio extension: ${ext || '(none)'}` });
      }
      const buf = await data.toBuffer(); // throws 413 over the fileSize limit
      const dir = mkdtempSync(join(tmpdir(), 'bi-dictation-'));
      try {
        const audioPath = join(dir, `audio.${ext}`);
        writeFileSync(audioPath, buf);
        const text = await transcribeAudio(audioPath, whisperCmd, transcribeDeps);
        return { text };
      } catch {
        return reply.code(502).send({ error: 'transcription failed' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // BI-C8: local-runs usage totals (today / last 7 days / this month) from
    // the sessionsDir JSONLs. Local runs only — NOT subscription limits.
    scoped.get('/usage/summary', async () => usageSummary());

    // BI-C2: single source for the app's pickers — repos, models, efforts from config.
    scoped.get('/sessions/meta', async () => ({
      repos: Object.keys(repoAllowlist),
      models,
      efforts,
    }));

    // BI-C2: non-streaming snapshot for mobile polling. Same offset contract as
    // the SSE route; `nextOffset` is what the client passes on the next poll.
    scoped.get<{ Params: { id: string }; Querystring: { offset?: string } }>(
      '/sessions/:id/events.json',
      async (req, reply) => {
        const { id } = req.params;
        if (!store.has(id)) return reply.code(404).send({ error: 'unknown session' });
        const offset = Number(req.query.offset ?? '0');
        const fromOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
        const all = store.readEvents(id);
        return {
          events: all.filter((e) => e.index >= fromOffset),
          nextOffset: all.length,
          state: sessionState(all),
        };
      },
    );

    scoped.get<{ Params: { id: string }; Querystring: { offset?: string } }>(
      '/sessions/:id/events',
      (req, reply) => {
        const { id } = req.params;
        if (!store.has(id)) {
          void reply.code(404).send({ error: 'unknown session' });
          return;
        }
        const offset = Number(req.query.offset ?? '0');
        const fromOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
        streamEvents(store, id, fromOffset, reply);
      },
    );

    scoped.post<{ Params: { id: string }; Body: { requestId?: unknown } }>(
      '/sessions/:id/approve',
      async (req, reply) => {
        if (!store.has(req.params.id)) return reply.code(404).send({ error: 'unknown session' });
        const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
        if (!requestId) return reply.code(400).send({ error: 'requestId required' });
        if (!runner.approve(req.params.id, requestId)) {
          return reply.code(409).send({ error: 'no pending approval for that requestId' });
        }
        return { ok: true };
      },
    );

    scoped.post<{ Params: { id: string }; Body: { requestId?: unknown; message?: unknown } }>(
      '/sessions/:id/deny',
      async (req, reply) => {
        if (!store.has(req.params.id)) return reply.code(404).send({ error: 'unknown session' });
        const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
        if (!requestId) return reply.code(400).send({ error: 'requestId required' });
        const message = typeof req.body?.message === 'string' ? req.body.message : undefined;
        if (!runner.deny(req.params.id, requestId, message)) {
          return reply.code(409).send({ error: 'no pending approval for that requestId' });
        }
        return { ok: true };
      },
    );

    scoped.post<{ Params: { id: string }; Body: { mode?: unknown } }>(
      '/sessions/:id/mode',
      async (req, reply) => {
        if (!store.has(req.params.id)) return reply.code(404).send({ error: 'unknown session' });
        const mode = typeof req.body?.mode === 'string' ? req.body.mode : '';
        if (!MODES.has(mode)) return reply.code(400).send({ error: 'mode must be gated, acceptEdits or auto' });
        if (!(await runner.setMode(req.params.id, mode as SessionPermissionMode))) {
          return reply.code(409).send({ error: 'session is not running' });
        }
        return { ok: true };
      },
    );

    scoped.post<{ Params: { id: string }; Body: { text?: unknown } }>(
      '/sessions/:id/message',
      async (req, reply) => {
        if (!store.has(req.params.id)) return reply.code(404).send({ error: 'unknown session' });
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) return reply.code(400).send({ error: 'text required' });
        if (!runner.sendMessage(req.params.id, text)) {
          return reply.code(409).send({ error: 'session is not running' });
        }
        return { ok: true };
      },
    );

    done();
  });
}

function streamEvents(store: SessionStore, id: string, fromOffset: number, reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  reply.hijack();

  const write = (event: { event: string } & Record<string, unknown>): void => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const isTerminal = (state: string): boolean => state === 'done' || state === 'error' || state === 'paused';

  const replayed = store.readEvents(id, fromOffset);
  for (const e of replayed) write(e);

  // If the session already reached a terminal state, the full history is on the
  // wire — close the stream so `?offset=` re-attach is a clean finite replay.
  const summary = store.listSessions().find((s) => s.id === id);
  if (summary && isTerminal(summary.state)) {
    reply.raw.end();
    return;
  }

  const unsubscribe = store.subscribe(id, (event) => {
    write(event);
    if (event.event === 'status' && typeof event.status === 'string' && isTerminal(event.status)) {
      unsubscribe();
      reply.raw.end();
    }
  });
  reply.raw.on('close', unsubscribe);
}
