// MC-R1: the code-review brief a review session starts from. The session runs
// as a normal gated coding session inside the repo's local checkout; the diff
// comes from read-only `gh pr view` / `gh pr diff` (both bash-allowlisted).
// HARD RULE: a review session never writes to GitHub — the brief forbids it and
// the permission gate blocks any un-allowlisted command anyway.
//
// MC-R6 adds a SECOND builder: the full-review brief for `market-clue` PRs.
// That flow runs in a dedicated worktree with the PR head checked out, writes
// a review doc into the MC brain following the mc-superpowers brain-pr-review
// conventions, opens a brain PR with it, and posts verdict-conditional
// feedback on the platform PR — everything authored as richsmon. The owner
// split is load-bearing: anything not owned by the org keeps the MC-R1
// read-only brief byte-for-byte.

export interface ReviewBriefInput {
  /** Repo owner — the team org or the founder's user (MC-R2). */
  owner: string;
  repo: string;
  pr: number;
}

export function buildReviewPrompt({ owner, repo, pr }: ReviewBriefInput): string {
  const slug = `${owner}/${repo}`;
  return [
    `Run a READ-ONLY code review of pull request #${pr} in ${slug}.`,
    '',
    'Steps:',
    `1. Run \`gh pr view ${pr} --repo ${slug}\` to read the PR title, description and metadata.`,
    `2. Run \`gh pr diff ${pr} --repo ${slug}\` to get the full diff.`,
    '3. Use the local checkout in your working directory to read surrounding code for context. It may be on a different branch than the PR — treat it as reference only.',
    '',
    'Ground rules (non-negotiable):',
    '- Read-only towards GitHub: never post comments, reviews, approvals or labels; never push. Commands like `gh pr comment`, `gh pr review`, `gh pr merge` or `git push` are forbidden.',
    '- Do not create, edit or delete any files.',
    '- Findings go into your final message only.',
    '',
    'Deliver the review as your final message, structured as:',
    '- **Verdict** — approve / request-changes / comment, with one sentence why.',
    '- **Findings** — numbered; each with severity (high / medium / low), file and line, what is wrong, and a concrete fix.',
    '- **Test gaps** — behavior the diff changes that no test covers.',
    '',
    // MC-R4: the machine-readable tail the app renders as structured findings.
    'END the final message with a machine-readable copy of the same review: a fenced code block tagged `findings-json` containing ONLY one JSON object of exactly this shape:',
    '',
    '```findings-json',
    '{"verdict": "approve" | "request-changes" | "comment",',
    ' "findings": [{"severity": "high" | "medium" | "low", "file": "src/x.ts", "line": 42, "title": "one-line problem", "detail": "what is wrong and the concrete fix"}]}',
    '```',
    '',
    'Block rules: it is the LAST thing in the message; `file` and `line` are optional — omit them when a finding is not tied to one spot; a clean approve is `{"verdict": "approve", "findings": []}`. The app parses this block to render the review — without it the review shows only as raw text.',
  ].join('\n');
}

/** MC-R6: everything the full-review brief needs to pin the session to one
 * worktree, one MC-brain checkout and one PR. */
export interface FullReviewBriefInput {
  /** The MC org — also the owner of the brain repo (`{owner}/brain`). */
  owner: string;
  repo: string;
  pr: number;
  /** The PR's head branch (already checked out in the worktree). */
  branch: string;
  /** Dedicated worktree with the PR head checked out — the session's cwd. */
  worktreePath: string;
  /** Local checkout of the MC brain repo. */
  mcBrainPath: string;
}

/**
 * MC-R6: the FULL-review brief for `market-clue` PRs. Deliverables: review doc
 * as a PR in the MC brain + verdict-conditional feedback on the platform PR.
 * The bash commands prescribed here match the session-scoped allowlist
 * prefixes (worktree.ts fullReviewBashAllowlist) EXACTLY — a differently
 * spelled command gates on approval.
 */
export function buildFullReviewPrompt(input: FullReviewBriefInput): string {
  const { owner, repo, pr, branch, worktreePath, mcBrainPath } = input;
  const slug = `${owner}/${repo}`;
  const brainBranch = `mc-review/${repo}-pr-${pr}`;
  return [
    `Run a FULL code review of pull request #${pr} in ${slug} (branch \`${branch}\`).`,
    '',
    `Your working directory is a dedicated git worktree at ${worktreePath} with the PR head already checked out — you are reviewing the REAL code of the PR, not a stale main. The local checkout of the market-clue brain repo is at ${mcBrainPath}.`,
    '',
    'IDENTITY — NON-NEGOTIABLE, RESTATED ON PURPOSE:',
    `Every git commit, every PR and every comment you produce MUST read as authored by richsmon — a human. ZERO mentions of AI, Claude, agents or assistants anywhere: not in commit messages, not in PR titles or bodies, not in review comments, and NO Co-Authored-By trailers. Commits are signed automatically by the machine-wide git signing config — never touch git config, signing keys or author identity.`,
    '',
    'Step 1 — review the PR:',
    `- Run \`gh pr view ${pr} --repo ${slug}\` for title, description, metadata.`,
    `- Run \`gh pr diff ${pr} --repo ${slug}\` for the full diff.`,
    '- Read the surrounding code in the worktree for context; run the tests if it helps.',
    '- Form findings (numbered; severity high / medium / low; file and line; what is wrong; a concrete fix) and a verdict: approve / request-changes / comment.',
    '',
    'Step 2 — write the review doc in the MC brain (brain-pr-review conventions):',
    `- Resolve the MC Story key (\`MC-{n}\`): first from the branch name \`${branch}\`, then the PR title, then the PR body. No key found ⇒ keyless lane: drop the \`{MC-key}--\` filename prefix.`,
    `- Detect the feature: from the brain root, \`grep -rl "MC-{n}" workspaces/*/features/*/plan.md\` — a hit's path IS the feature folder. No key or no hit ⇒ fall back to branch/title heuristics; still nothing ⇒ no feature.`,
    `- Doc path: \`workspaces/{workspace}/features/{feature}/reviews/{MC-key}--${repo}-pr-${pr}.md\`. Fallback when no feature resolves: \`workspaces/{workspace}/reviews/\`; last resort \`reviews/\` at the brain root. Create the reviews/ folder if missing. The workspace is the brain workspace linked to the ${repo} repo (check \`graph/entities/*.yaml\` for the repo URL).`,
    '- Doc content: frontmatter (jira key if resolved, repo, PR URL, status, dates), TL;DR, findings table with severities, detailed findings, a Dispositions table with every row `pending`.',
    '',
    'Step 3 — open the brain PR (the founder merges it, NEVER you):',
    `- \`git -C ${mcBrainPath} fetch origin\``,
    `- \`git -C ${mcBrainPath} switch -c ${brainBranch} origin/main\` (always branch from origin/main, never from local main)`,
    `- \`git -C ${mcBrainPath} add <the review doc>\`, then \`git -C ${mcBrainPath} commit\` with a short human message (e.g. "review: ${repo} PR #${pr}").`,
    `- \`git -C ${mcBrainPath} push origin ${brainBranch}\``,
    `- \`gh pr create --repo ${owner}/brain --head ${brainBranch}\` with a human title and a 2-3 line body summarizing the verdict. Do NOT merge it. Do not enable auto-merge.`,
    '',
    'Step 4 — feedback on the platform PR, STRICTLY verdict-conditional:',
    `- Post one comment per finding: \`gh pr comment ${pr} --repo ${slug} --body "..."\` — each names the file/line, the problem and the concrete fix.`,
    `- Verdict approve ⇒ \`gh pr review ${pr} --repo ${slug} --approve --body "..."\`. Approve ONLY on a genuine approve verdict — a hollow approve is worse than none.`,
    `- Verdict request-changes ⇒ \`gh pr review ${pr} --repo ${slug} --request-changes --body "..."\`.`,
    `- Verdict comment ⇒ \`gh pr review ${pr} --repo ${slug} --comment --body "..."\`.`,
    '',
    'Ground rules (non-negotiable):',
    `- Touch NOTHING outside the worktree (${worktreePath}) and the MC brain checkout (${mcBrainPath}). Never edit the main checkouts, never cd elsewhere, never modify this PR's source branch.`,
    '- Never push to the platform PR branch; never merge, close or label any PR; never force-push.',
    '- Run each prescribed command as a single, unchained command — no `&&`, `;` or pipes around git/gh writes.',
    '- The worktree is cleaned up by the server after the session — leave it as is.',
    '',
    'Deliver the review as your final message, structured as:',
    '- **Verdict** — approve / request-changes / comment, with one sentence why.',
    '- **Findings** — numbered; each with severity (high / medium / low), file and line, what is wrong, and a concrete fix.',
    '- **Test gaps** — behavior the diff changes that no test covers.',
    `- A line of exactly this form so the app can link it: \`Brain PR: <url>\` — the URL printed when the brain PR was created.`,
    '',
    'END the final message with a machine-readable copy of the same review: a fenced code block tagged `findings-json` containing ONLY one JSON object of exactly this shape:',
    '',
    '```findings-json',
    '{"verdict": "approve" | "request-changes" | "comment",',
    ' "findings": [{"severity": "high" | "medium" | "low", "file": "src/x.ts", "line": 42, "title": "one-line problem", "detail": "what is wrong and the concrete fix"}]}',
    '```',
    '',
    'Block rules: it is the LAST thing in the message (the `Brain PR:` line comes BEFORE it); `file` and `line` are optional — omit them when a finding is not tied to one spot; a clean approve is `{"verdict": "approve", "findings": []}`. The app parses this block to render the review — without it the review shows only as raw text.',
  ].join('\n');
}
