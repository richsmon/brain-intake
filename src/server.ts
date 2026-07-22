import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { appendEvent, createItem, itemState, readEvents, type InboxEvent } from './inbox.js';
import { AUDIO_EXTS, transcribeItem } from './transcribe.js';
import { makeApprovals, type Approvals } from './approvals.js';
import type { IntakeTrigger } from './intake-trigger.js';
import { answerQuestion, listOpenQuestions, type ExecFn } from './questions.js';
import { parseLoopReport, type LoopRunSummary } from './loop-report.js';
import type { SessionModel } from './config.js';
import { SessionStore } from './sessions/store.js';
import { SessionRunner, type SessionSdk } from './sessions/runner.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { PushTokenStore } from './push/tokens.js';
import { PushSender } from './push/sender.js';
import { wireSessionPush } from './push/wire.js';
import { ApnsClient, type ApnsKeyConfig, type ApnsTransport } from './push/apns.js';

export interface ServerConfig {
  brainRoot: string;
  /** IN-5 vault — raw captures live here, outside git. Defaults to brainRoot
   * (tests); production always passes the real vault. */
  vaultRoot?: string;
  /** Multipart file-size cap in bytes. Default 25 MB. */
  maxUploadBytes?: number;
  /** Shell command printing a transcript of `{input}` to stdout (BI-06).
   * Unset = transcription disabled; audio items stay raw. */
  whisperCmd?: string;
  /** Fires an instant intake pass after each capture (voice: after transcript). */
  intakeTrigger?: IntakeTrigger;
  /** Test seam for the questions writeback git commit. */
  questionsExec?: ExecFn;
  /** Test seam; defaults to gh-backed approvals in brainRoot. */
  approvals?: Approvals;
  /** BI-C1 coding surface. Registered only when a bearer token is configured. */
  sessions?: {
    sessionsDir: string;
    repoAllowlist: Record<string, string>;
    bashAllowlist: string[];
    approvalTimeoutMin: number;
    token: string;
    /** BI-C2: picker values served by `GET /sessions/meta`. */
    models: SessionModel[];
    efforts: string[];
    /** Test seam: inject a fake Agent SDK. Production wires the real query(). */
    sdk: SessionSdk;
    /** BI-C3: direct-APNs push key. Absent ⇒ pushes are a silent no-op
     * (registration still works, so devices are ready when the key lands). */
    apns?: ApnsKeyConfig;
    /** BI-C3: test seam for the APNs HTTP/2 request. Production uses node:http2. */
    apnsTransport?: ApnsTransport;
  };
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
  kind?: string;
}

const INTAKE_KINDS = new Set(['idea', 'note', 'task', 'from-people', 'reference', 'journal', 'improvement']);

function parseJsonBody(body: unknown): PostItemBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.source !== 'string' || !JSON_SOURCES.has(b.source)) return null;
  if (typeof b.text !== 'string' || b.text.length === 0) return null;
  if (b.originalName !== undefined && typeof b.originalName !== 'string') return null;
  if (b.deviceTs !== undefined && typeof b.deviceTs !== 'string') return null;
  if (b.kind !== undefined && (typeof b.kind !== 'string' || !INTAKE_KINDS.has(b.kind))) return null;
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
  const inboxDir = join(config.vaultRoot ?? config.brainRoot, 'inbox');
  const app = Fastify({ logger: process.env.LOG_REQUESTS === '1' });
  app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES },
  });

  app.get('/health', async () => ({ ok: true, brainRoot: config.brainRoot }));

  // BI-C1: coding surface. Gated behind a bearer token — no token, no sessions API.
  if (config.sessions) {
    const store = new SessionStore(config.sessions.sessionsDir);
    const runner = new SessionRunner({
      store,
      sdk: config.sessions.sdk,
      bashAllowlist: config.sessions.bashAllowlist,
      approvalTimeoutMs: config.sessions.approvalTimeoutMin * 60_000,
    });
    // BI-C3: session pushes over direct APNs. Registration is always mounted
    // (devices can register before the .p8 key exists); delivery is wired only
    // when the APNs key config is present — otherwise every send is a silent
    // no-op and the server runs unchanged.
    const pushTokens = new PushTokenStore(config.sessions.sessionsDir);
    const apnsClient =
      config.sessions.apns !== undefined
        ? new ApnsClient(config.sessions.apns, config.sessions.apnsTransport)
        : undefined;
    const pushSender = new PushSender({
      tokens: pushTokens,
      onError: (err) => app.log.error({ err }, 'session push failed'),
      ...(apnsClient !== undefined ? { client: apnsClient } : {}),
    });
    wireSessionPush({ store, sender: pushSender });
    registerSessionRoutes(app, {
      store,
      runner,
      repoAllowlist: config.sessions.repoAllowlist,
      token: config.sessions.token,
      models: config.sessions.models,
      efforts: config.sessions.efforts,
      pushTokens,
    });
  }

  app.post('/items', async (req, reply) => {
    if (req.isMultipart()) {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'file part required' });

      // Form fields first; query-string fallback serves native uploaders
      // whose multipart field ordering is out of our control.
      const query = req.query as Record<string, string | undefined>;
      const source = multipartField(data.fields, 'source') ?? query.source;
      if (source === undefined || !UPLOAD_SOURCES.has(source)) {
        return reply.code(400).send({ error: 'multipart source must be voice or photo' });
      }
      const ext = extname(data.filename).slice(1).toLowerCase();
      if (!UPLOAD_EXTS.has(ext)) {
        return reply.code(400).send({ error: `extension not allowed: ${ext || '(none)'}` });
      }

      const deviceTs = multipartField(data.fields, 'deviceTs') ?? query.deviceTs;
      const cloud = multipartField(data.fields, 'cloud') ?? query.cloud;
      const buf = await data.toBuffer(); // throws 413 over the fileSize limit
      const result = createItem(inboxDir, buf, {
        source,
        ext,
        originalName: data.filename,
        ...(deviceTs !== undefined ? { deviceTs } : {}),
      });
      if (cloud === '1' || cloud === 'true') {
        appendEvent(join(inboxDir, result.id), { event: 'cloud-requested', via: 'app-toggle' });
      }
      const kindHint = multipartField(data.fields, 'kind') ?? query.kind;
      if (kindHint !== undefined && INTAKE_KINDS.has(kindHint)) {
        appendEvent(join(inboxDir, result.id), { event: 'kind-hint', kind: kindHint });
      }
      // Background-task shape: capture answers immediately; the transcript
      // lands later as a `transcribed` event on the same trail.
      const whisperCmd = config.whisperCmd;
      if (whisperCmd !== undefined && AUDIO_EXTS.has(ext)) {
        void transcribeItem(join(inboxDir, result.id), whisperCmd)
          .catch((err: unknown) => {
            app.log.error({ err, item: result.id }, 'transcription failed');
          })
          .finally(() => config.intakeTrigger?.fire());
      } else {
        config.intakeTrigger?.fire();
      }
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
    if (body.kind !== undefined) {
      appendEvent(join(inboxDir, result.id), { event: 'kind-hint', kind: body.kind });
    }
    config.intakeTrigger?.fire();
    return reply.code(201).send(result);
  });

  app.get('/items', async () => {
    const out = [];
    for (const id of itemDirs(inboxDir)) {
      const events = readEvents(join(inboxDir, id));
      if (events.length === 0) continue;
      const title = lastClassifiedTitle(events);
      const outcome = events.find((e) => e.event === 'became' || e.event === 'categorized');
      const kind = typeof outcome?.kind === 'string' ? outcome.kind : undefined;
      const labelled = [...events].reverse().find((e) => Array.isArray(e.labels));
      const labels = labelled?.labels as string[] | undefined;
      out.push({
        id,
        state: itemState(events),
        lastEvent: events[events.length - 1]!.event,
        ...(title !== undefined ? { title } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(labels !== undefined ? { labels } : {}),
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

    const transcriptPath = join(dir, 'transcript.md');
    const transcript = existsSync(transcriptPath)
      ? readFileSync(transcriptPath, 'utf-8')
      : undefined;

    return {
      id: req.params.id,
      state: itemState(events),
      events,
      ...(payload !== undefined ? { payload } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
    };
  });

  const approvals = config.approvals ?? makeApprovals({ brainRoot: config.brainRoot });

  app.get('/questions', async () => listOpenQuestions(config.brainRoot));

  app.post<{ Params: { id: string } }>('/questions/:id/answer', async (req, reply) => {
    const body = req.body as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.code(400).send({ error: 'expected {text}' });
    const ok = await answerQuestion(config.brainRoot, req.params.id, text, config.questionsExec);
    if (!ok) return reply.code(404).send({ error: 'unknown or already answered question' });
    return { ok: true };
  });

  app.get('/approvals', async (_req, reply) => {
    try {
      return await approvals.list();
    } catch (err) {
      app.log.error({ err }, 'gh approvals list failed');
      return reply.code(502).send({ error: 'gh unavailable' });
    }
  });

  app.post<{ Params: { number: string } }>('/approvals/:number/approve', async (req, reply) => {
    try {
      await approvals.approve(Number(req.params.number));
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'gh merge failed');
      return reply.code(502).send({ error: 'merge failed' });
    }
  });

  app.post<{ Params: { number: string } }>('/approvals/:number/reject', async (req, reply) => {
    try {
      await approvals.reject(Number(req.params.number));
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'gh close failed');
      return reply.code(502).send({ error: 'close failed' });
    }
  });

  app.get('/cloud-approvals', async () => {
    const out = [];
    for (const id of itemDirs(inboxDir)) {
      const events = readEvents(join(inboxDir, id));
      if (itemState(events) !== 'cloud-approval') continue;
      const pending = [...events].reverse().find((e) => e.event === 'cloud-approval');
      out.push({
        id,
        title: typeof pending?.title === 'string' ? pending.title : id,
        reason: typeof pending?.reason === 'string' ? pending.reason : '',
      });
    }
    return out;
  });

  app.post<{ Params: { id: string } }>('/items/:id/cloud-approve', async (req, reply) => {
    const dir = join(inboxDir, req.params.id);
    const events = existsSync(dir) ? readEvents(dir) : [];
    if (events.length === 0 || itemState(events) !== 'cloud-approval') {
      return reply.code(404).send({ error: 'no pending cloud approval' });
    }
    appendEvent(dir, { event: 'cloud-requested', via: 'app-approve' });
    appendEvent(dir, { event: 'queued' });
    config.intakeTrigger?.fire();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/items/:id/keep-local', async (req, reply) => {
    const dir = join(inboxDir, req.params.id);
    const events = existsSync(dir) ? readEvents(dir) : [];
    if (events.length === 0 || itemState(events) !== 'cloud-approval') {
      return reply.code(404).send({ error: 'no pending cloud approval' });
    }
    appendEvent(dir, { event: 'needs-human', reason: 'founder kept it local — route by hand' });
    return { ok: true };
  });

  app.get('/digest', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const counts = { captured: 0, became: 0, categorized: 0, needsHuman: 0, cloudApprovals: 0 };
    const highlights = [];
    for (const id of itemDirs(inboxDir)) {
      const events = readEvents(join(inboxDir, id));
      if (events.length === 0) continue;
      const state = itemState(events);
      if (state === 'cloud-approval') counts.cloudApprovals += 1;
      const todays = events.filter((e) => typeof e.ts === 'string' && e.ts.startsWith(today));
      if (todays.length === 0) continue;
      if (todays.some((e) => e.event === 'captured')) counts.captured += 1;
      if (todays.some((e) => e.event === 'became')) counts.became += 1;
      if (todays.some((e) => e.event === 'categorized')) counts.categorized += 1;
      if (todays.some((e) => e.event === 'needs-human')) counts.needsHuman += 1;
      if (['became', 'categorized', 'needs-human'].includes(state)) {
        const outcome = events.find((e) => e.event === 'became' || e.event === 'categorized');
        const title = lastClassifiedTitle(events);
        highlights.push({
          id,
          state,
          ...(title !== undefined ? { title } : {}),
          ...(typeof outcome?.kind === 'string' ? { kind: outcome.kind } : {}),
        });
      }
    }
    const loopDisabled = existsSync(join(config.brainRoot, '.brain', 'loop-disabled'));
    const reportsDir = join(config.brainRoot, 'reports', 'brain-loop');
    const lastReport = existsSync(reportsDir)
      ? (readdirSync(reportsDir).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort().pop() ?? null)
      : null;
    let loop: LoopRunSummary | null = null;
    if (lastReport !== null) {
      try {
        loop = parseLoopReport(lastReport, readFileSync(join(reportsDir, lastReport), 'utf8'));
      } catch {
        loop = null;
      }
    }
    return { date: today, counts, highlights: highlights.slice(-8).reverse(), loopDisabled, lastReport, loop };
  });

  app.get('/fleet', async () => {
    const loopDisabled = existsSync(join(config.brainRoot, '.brain', 'loop-disabled'));
    const reportsDir = join(config.brainRoot, 'reports', 'brain-loop');
    const lastReport = existsSync(reportsDir)
      ? (readdirSync(reportsDir).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort().pop() ?? null)
      : null;
    return { loopDisabled, lastReport };
  });

  return app;
}
