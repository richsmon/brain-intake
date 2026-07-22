// MC-R1: the code-review brief a review session starts from. The session runs
// as a normal gated coding session inside the repo's local checkout; the diff
// comes from read-only `gh pr view` / `gh pr diff` (both bash-allowlisted).
// HARD RULE: a review session never writes to GitHub — the brief forbids it and
// the permission gate blocks any un-allowlisted command anyway.

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
