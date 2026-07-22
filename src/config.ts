import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** BI-C2: a model choice the app's picker offers. Server config is the single source. */
export interface SessionModel {
  id: string;
  label: string;
}

/** BI-C2: picker defaults for `GET /sessions/meta`. Override via SESSION_MODELS. */
export const DEFAULT_SESSION_MODELS: SessionModel[] = [
  { id: 'claude-fable-5', label: 'Fable' },
  { id: 'claude-opus-4-8', label: 'Opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet' },
  { id: 'claude-haiku-4-5', label: 'Haiku' },
];

/** BI-C2: reasoning-effort levels the picker offers. Override via SESSION_EFFORTS. */
export const DEFAULT_SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** BI-C1: bash commands the sessions permission gate lets through without approval.
 * MC-R1 adds the read-only `gh pr` reads a review session needs to fetch its diff. */
export const DEFAULT_BASH_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'ls',
  'npm test',
  'npm run test',
  'npx vitest',
  'pytest',
  'gh pr view',
  'gh pr diff',
];

/** MC-R1: defaults for the review surface — the org whose PRs are listed and
 * the directory local checkouts live under (`{root}/{repo}`). */
export const DEFAULT_REVIEWS_ORG = 'market-clue';

/** BI-C3: direct-APNs push config — all-or-nothing from APNS_* env vars. */
export interface ApnsEnvConfig {
  /** Path to the APNs auth key (.p8) — NOT the ASC upload key. */
  keyPath: string;
  keyId: string;
  teamId: string;
  /** apns-topic = bundle id. */
  topic: string;
  /** Optional override, e.g. the sandbox endpoint for dev builds. */
  endpoint?: string;
}

export const DEFAULT_APNS_TOPIC = 'com.richsmon.brain-intake';

export interface AppConfig {
  brainRoot: string;
  /** IN-5: raw captures live here, OUTSIDE the git repo. */
  vaultRoot: string;
  port: number;
  bind: string;
  whisperCmd?: string;
  /** BI-C1: JSONL session logs live here — vault-co-located, outside git. */
  sessionsDir: string;
  /** BI-C1: repo name → absolute checkout path. Sessions only spawn inside these. */
  repoAllowlist: Record<string, string>;
  /** BI-C1: command prefixes Bash may run without a permission gate. */
  bashAllowlist: string[];
  /** BI-C1: pending approval older than this ⇒ deny + session paused. */
  approvalTimeoutMin: number;
  /** BI-C1: bearer token guarding the sessions routes. Unset ⇒ sessions API disabled. */
  sessionsToken?: string;
  /** BI-C2: model picker values served by `GET /sessions/meta`. */
  sessionModels: SessionModel[];
  /** BI-C2: effort picker values served by `GET /sessions/meta`. */
  sessionEfforts: string[];
  /** BI-C3: direct-APNs push. Unset ⇒ pushes are a silent no-op. */
  apns?: ApnsEnvConfig;
  /** MC-R1: GitHub org the review surface lists open PRs for. */
  reviewsOrg: string;
  /** MC-R1: local checkouts of review repos live at `{root}/{repo}`. */
  reviewsCheckoutRoot: string;
}

function parseApns(env: Record<string, string | undefined>): ApnsEnvConfig | undefined {
  const keyPath = env.APNS_KEY_PATH;
  if (keyPath === undefined || keyPath === '') return undefined;
  if (!existsSync(keyPath)) throw new Error(`APNS_KEY_PATH does not exist: ${keyPath}`);
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  if (keyId === undefined || keyId === '' || teamId === undefined || teamId === '') {
    throw new Error('APNS_KEY_PATH is set — APNS_KEY_ID and APNS_TEAM_ID are required with it');
  }
  return {
    keyPath,
    keyId,
    teamId,
    topic: env.APNS_TOPIC !== undefined && env.APNS_TOPIC !== '' ? env.APNS_TOPIC : DEFAULT_APNS_TOPIC,
    ...(env.APNS_ENDPOINT !== undefined && env.APNS_ENDPOINT !== '' ? { endpoint: env.APNS_ENDPOINT } : {}),
  };
}

function parseSessionModels(raw: string): SessionModel[] {
  const out: SessionModel[] = [];
  for (const pair of raw.split(',')) {
    const entry = pair.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`SESSION_MODELS entries must be id=Label: ${entry}`);
    out.push({ id: entry.slice(0, eq).trim(), label: entry.slice(eq + 1).trim() });
  }
  if (out.length === 0) throw new Error('SESSION_MODELS must contain at least one id=Label entry');
  return out;
}

function parseRepoAllowlist(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const entry = pair.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`REPO_ALLOWLIST entries must be name=/abs/path: ${entry}`);
    const name = entry.slice(0, eq).trim();
    const path = entry.slice(eq + 1).trim();
    if (!existsSync(path)) throw new Error(`repo checkout for ${name} does not exist: ${path}`);
    out[name] = path;
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const brainRoot = env.BRAIN_ROOT;
  if (!brainRoot) throw new Error('BRAIN_ROOT is required (path to the brain repo checkout)');
  if (!existsSync(brainRoot)) throw new Error(`BRAIN_ROOT does not exist: ${brainRoot}`);
  const vaultRoot = env.VAULT_ROOT ?? join(homedir(), 'BrainVault');
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });

  let port = 8787;
  if (env.PORT !== undefined) {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer: ${env.PORT}`);
  }

  const sessionsDir = env.SESSIONS_DIR ?? join(vaultRoot, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const repoAllowlist = env.REPO_ALLOWLIST !== undefined ? parseRepoAllowlist(env.REPO_ALLOWLIST) : {};

  const bashAllowlist =
    env.BASH_ALLOWLIST !== undefined && env.BASH_ALLOWLIST !== ''
      ? env.BASH_ALLOWLIST.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [...DEFAULT_BASH_ALLOWLIST];

  let approvalTimeoutMin = 30;
  if (env.APPROVAL_TIMEOUT_MIN !== undefined) {
    approvalTimeoutMin = Number(env.APPROVAL_TIMEOUT_MIN);
    if (!Number.isFinite(approvalTimeoutMin) || approvalTimeoutMin <= 0) {
      throw new Error(`APPROVAL_TIMEOUT_MIN must be a positive number: ${env.APPROVAL_TIMEOUT_MIN}`);
    }
  }

  const sessionModels =
    env.SESSION_MODELS !== undefined && env.SESSION_MODELS !== ''
      ? parseSessionModels(env.SESSION_MODELS)
      : DEFAULT_SESSION_MODELS.map((m) => ({ ...m }));

  const sessionEfforts =
    env.SESSION_EFFORTS !== undefined && env.SESSION_EFFORTS !== ''
      ? env.SESSION_EFFORTS.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [...DEFAULT_SESSION_EFFORTS];

  return {
    brainRoot,
    vaultRoot,
    port,
    bind: env.BIND ?? '127.0.0.1',
    sessionsDir,
    repoAllowlist,
    bashAllowlist,
    approvalTimeoutMin,
    sessionModels,
    sessionEfforts,
    reviewsOrg: env.REVIEWS_ORG !== undefined && env.REVIEWS_ORG !== '' ? env.REVIEWS_ORG : DEFAULT_REVIEWS_ORG,
    reviewsCheckoutRoot:
      env.REVIEWS_CHECKOUT_ROOT !== undefined && env.REVIEWS_CHECKOUT_ROOT !== ''
        ? env.REVIEWS_CHECKOUT_ROOT
        : join(homedir(), 'code', DEFAULT_REVIEWS_ORG),
    ...(env.WHISPER_CMD !== undefined && env.WHISPER_CMD !== ''
      ? { whisperCmd: env.WHISPER_CMD }
      : {}),
    ...(env.SESSIONS_TOKEN !== undefined && env.SESSIONS_TOKEN !== ''
      ? { sessionsToken: env.SESSIONS_TOKEN }
      : {}),
    ...((): { apns?: ApnsEnvConfig } => {
      const apns = parseApns(env);
      return apns !== undefined ? { apns } : {};
    })(),
  };
}
