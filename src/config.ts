import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AppConfig {
  brainRoot: string;
  port: number;
  bind: string;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const brainRoot = env.BRAIN_ROOT;
  if (!brainRoot) throw new Error('BRAIN_ROOT is required (path to the brain repo checkout)');
  if (!existsSync(join(brainRoot, 'inbox'))) {
    throw new Error(`BRAIN_ROOT has no inbox/ dir: ${brainRoot}`);
  }

  let port = 8787;
  if (env.PORT !== undefined) {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer: ${env.PORT}`);
  }

  return { brainRoot, port, bind: env.BIND ?? '127.0.0.1' };
}
