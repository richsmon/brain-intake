// MC-R1: the ONLY module that shells out to the real `gh` CLI. Everything else
// in the reviews feature talks to the injected `GhRunner`, so routes and PR
// listing are driven by a fake in tests — no network, no GitHub.
import { execFile } from 'node:child_process';

/** Runs `gh <args>` and resolves stdout. Rejects when gh exits non-zero. */
export type GhRunner = (args: string[]) => Promise<string>;

const MAX_BUFFER = 10 * 1024 * 1024;

export function createRealGhRunner(): GhRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('gh', args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) reject(new Error(`gh ${args[0] ?? ''} failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
    });
}
