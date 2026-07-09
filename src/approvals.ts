// A2 Approvals: open loop/* PRs in the brain repo, with the verifier's verdict,
// and approve-first actions. Approve = the founder merging remotely (`gh pr
// merge --squash`) — the loop itself still never merges. Everything shells to
// `gh` with the operator's own auth; the tailnet is the trust boundary, and
// the app adds an explicit confirm before any action.

import { execFile } from 'node:child_process';

export interface Approval {
  number: number;
  title: string;
  branch: string;
  url: string;
  verdict?: string;
}

export type ExecStdoutFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<string>;

const defaultExec: ExecStdoutFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

export function makeApprovals({
  brainRoot,
  execFn = defaultExec,
}: {
  brainRoot: string;
  execFn?: ExecStdoutFn;
}) {
  const gh = (args: string[]) => execFn('gh', args, { cwd: brainRoot });

  return {
    async list(): Promise<Approval[]> {
      const raw = await gh(['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url']);
      const prs = (JSON.parse(raw) as { number: number; title: string; headRefName: string; url: string }[])
        .filter((pr) => pr.headRefName.startsWith('loop/'));
      const out: Approval[] = [];
      for (const pr of prs) {
        let verdict: string | undefined;
        try {
          const rawComments = await gh(['pr', 'view', String(pr.number), '--json', 'comments']);
          const comments = (JSON.parse(rawComments).comments ?? []) as { body?: string }[];
          for (const comment of comments) {
            const match = comment.body?.match(/VERDICT:\s*(PASS|REJECT).*/);
            if (match) verdict = match[0].split('\n')[0]!.trim();
          }
        } catch {
          // No verdict is a valid state — the card just shows none.
        }
        out.push({
          number: pr.number,
          title: pr.title,
          branch: pr.headRefName,
          url: pr.url,
          ...(verdict !== undefined ? { verdict } : {}),
        });
      }
      return out;
    },

    async approve(number: number): Promise<void> {
      await gh(['pr', 'merge', String(number), '--squash']);
    },

    async reject(number: number): Promise<void> {
      await gh(['pr', 'close', String(number), '--comment', 'Rejected from the phone (Brainer Act).']);
    },
  };
}

export type Approvals = ReturnType<typeof makeApprovals>;
