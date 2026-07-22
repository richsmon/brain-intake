// MC-R6: worktree lifecycle + session-scoped allowlist for FULL MC reviews.
//
// A full review (owner === the MC org) runs inside a dedicated, unique git
// worktree of the target repo with the PR head checked out — the session
// reviews the REAL code, never a stale main. The server owns the whole
// lifecycle: worktree added before the session starts, removed on the
// session's terminal state (done/error/paused) via the store's status trail —
// cleanup is never trusted to the model.
//
// Like gh.ts, the real `git` shell-out lives behind an injected runner so
// tests script every call — no real repos, no filesystem side effects.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { GhRunner } from './gh.js';

/** Runs `git <args>` and resolves stdout. Rejects when git exits non-zero. */
export type GitRunner = (args: string[]) => Promise<string>;

const MAX_BUFFER = 10 * 1024 * 1024;

export function createRealGitRunner(): GitRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.filter((a) => a !== '-C').slice(0, 3).join(' ')} failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
    });
}

/** The PR's head branch, from `gh pr view --json headRefName`. */
export async function resolvePrBranch(gh: GhRunner, slug: string, pr: number): Promise<string> {
  const stdout = await gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'headRefName']);
  const parsed = JSON.parse(stdout) as { headRefName?: unknown };
  if (typeof parsed.headRefName !== 'string' || parsed.headRefName === '') {
    throw new Error(`gh pr view returned no headRefName for ${slug}#${pr}`);
  }
  return parsed.headRefName;
}

/** Unique path for one review's worktree — never reused, safe for concurrent
 * reviews of the same PR. */
export function uniqueWorktreePath(base: string, repo: string, pr: number): string {
  return join(base, `mc-review-${repo}-pr-${pr}-${randomBytes(4).toString('hex')}`);
}

/**
 * Fetch the PR head and add a worktree with it checked out. The checkout is
 * detached at FETCH_HEAD on purpose: `git fetch origin <branch>` only writes
 * FETCH_HEAD (no refspec — no remote-tracking update), and a detached worktree
 * can never collide with a same-named local branch held by another worktree.
 */
export async function addWorktree(
  git: GitRunner,
  checkoutPath: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  await git(['-C', checkoutPath, 'fetch', 'origin', branch]);
  await git(['-C', checkoutPath, 'worktree', 'add', '--detach', worktreePath, 'FETCH_HEAD']);
}

/** Server-side cleanup on the session's terminal transition — force, because
 * the session may have left scratch files behind. */
export async function removeWorktree(git: GitRunner, checkoutPath: string, worktreePath: string): Promise<void> {
  await git(['-C', checkoutPath, 'worktree', 'remove', '--force', worktreePath]);
}

export interface FullReviewScope {
  /** The MC org (`market-clue`) — also the owner of the brain repo. */
  owner: string;
  repo: string;
  pr: number;
  worktreePath: string;
  mcBrainPath: string;
}

/**
 * The EXACT bash-allowlist extension for one full review, pinned to this one
 * worktree, this one MC-brain checkout and this one PR. Prefix-matched by the
 * runner (entry, or entry + ' '), so every entry names its `-C <path>` or
 * `--repo`/PR-number scope up front — a command against any other path or PR
 * fails the prefix and gates like everything else.
 *
 * Same caveat as DEFAULT_BASH_ALLOWLIST: the gate is a tap-saver against a
 * cooperative agent, not a sandbox — shell operators after an allowed prefix
 * pierce any prefix. The brief therefore prescribes single, unchained commands.
 */
export function fullReviewBashAllowlist(scope: FullReviewScope): string[] {
  const { owner, repo, pr, worktreePath: wt, mcBrainPath: mb } = scope;
  return [
    // Review worktree: stage/commit/push/switch inside it only. Reads
    // (status/diff/log) ride the default allowlist since the worktree is cwd.
    `git -C ${wt} add`,
    `git -C ${wt} commit`,
    `git -C ${wt} push`,
    `git -C ${wt} switch`,
    // MC brain checkout: reads must be path-scoped too (cwd is the worktree,
    // so the default `git status` prefix doesn't cover them), plus fetch to
    // branch the review-doc PR from origin/main.
    `git -C ${mb} status`,
    `git -C ${mb} diff`,
    `git -C ${mb} log`,
    `git -C ${mb} fetch`,
    `git -C ${mb} switch`,
    `git -C ${mb} add`,
    `git -C ${mb} commit`,
    `git -C ${mb} push`,
    // The review-doc PR in the MC brain, and feedback on the ONE target PR.
    `gh pr create --repo ${owner}/brain`,
    `gh pr comment ${pr} --repo ${owner}/${repo}`,
    `gh pr review ${pr} --repo ${owner}/${repo}`,
  ];
}
