import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** BI-C1: bash commands the sessions permission gate lets through without approval. */
export const DEFAULT_BASH_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'ls',
  'npm test',
  'npm run test',
  'npx vitest',
  'pytest',
];

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

  return {
    brainRoot,
    vaultRoot,
    port,
    bind: env.BIND ?? '127.0.0.1',
    sessionsDir,
    repoAllowlist,
    bashAllowlist,
    approvalTimeoutMin,
    ...(env.WHISPER_CMD !== undefined && env.WHISPER_CMD !== ''
      ? { whisperCmd: env.WHISPER_CMD }
      : {}),
    ...(env.SESSIONS_TOKEN !== undefined && env.SESSIONS_TOKEN !== ''
      ? { sessionsToken: env.SESSIONS_TOKEN }
      : {}),
  };
}
