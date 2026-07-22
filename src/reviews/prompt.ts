// MC-R1: the code-review brief a review session starts from. The session runs
// as a normal gated coding session inside the repo's local checkout; the diff
// comes from read-only `gh pr view` / `gh pr diff` (both bash-allowlisted).
// HARD RULE: a review session never writes to GitHub — the brief forbids it and
// the permission gate blocks any un-allowlisted command anyway.

export interface ReviewBriefInput {
  org: string;
  repo: string;
  pr: number;
}

export function buildReviewPrompt({ org, repo, pr }: ReviewBriefInput): string {
  const slug = `${org}/${repo}`;
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
    '- **Verdict** — approve / request changes / needs discussion, with one sentence why.',
    '- **Findings** — numbered; each with severity (blocker / major / minor / nit), file and line, what is wrong, and a concrete fix.',
    '- **Test gaps** — behavior the diff changes that no test covers.',
  ].join('\n');
}
