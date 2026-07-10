import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  brainRoot: string;
  /** IN-5: raw captures live here, OUTSIDE the git repo. */
  vaultRoot: string;
  port: number;
  bind: string;
  whisperCmd?: string;
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

  return {
    brainRoot,
    vaultRoot,
    port,
    bind: env.BIND ?? '127.0.0.1',
    ...(env.WHISPER_CMD !== undefined && env.WHISPER_CMD !== ''
      ? { whisperCmd: env.WHISPER_CMD }
      : {}),
  };
}
