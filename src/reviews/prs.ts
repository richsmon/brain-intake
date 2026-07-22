// MC-R1: open-PR listing across a GitHub org. One GraphQL search call via the
// gh CLI returns every field the app's review list needs (branch + additions/
// deletions included) — no per-PR follow-up requests.
// MC-R2: the same single search also covers the founder's personal repos —
// GitHub search ORs multiple org:/user: qualifiers in one query (verified live),
// so it stays one call. Each row carries `owner` to disambiguate; `repo` stays
// the short name for compatibility with the app.
// MC-R3: each row also carries `lastReview` — the most recent review session
// already launched against that PR (or null) — so the list remembers what was
// reviewed. Derived from the session store via the `review` ref that POST
// /reviews stamps into session meta; pre-MC-R3 sessions have no ref and stay
// unlinked.
import { severityCounts, type ReviewVerdict, type SeverityCounts } from '../sessions/findings.js';
import type { SessionSummary } from '../sessions/store.js';
import type { GhRunner } from './gh.js';

export interface ReviewPr {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  updatedAt: string;
  additions: number;
  deletions: number;
}

/** MC-R4: compact findings summary for a PR row — verdict + counts, not the
 * full finding list (the session detail carries that). */
export interface LastReviewFindings {
  verdict: ReviewVerdict;
  counts: SeverityCounts;
  total: number;
}

/** MC-R3: the most recent review session launched against a PR. */
export interface LastReview {
  sessionId: string;
  ts: string;
  state: SessionSummary['state'];
  outcome?: 'success' | 'error';
  /** MC-R4: present once the session has a result — the parsed findings
   * summary, or null when the final message had no usable findings block. */
  findings?: LastReviewFindings | null;
}

export interface ReviewPrRow extends ReviewPr {
  lastReview: LastReview | null;
}

/**
 * MC-R3: attach each PR's most recent review session. Sessions match on the
 * `review` ref {owner, repo, pr}; the newest `createdAt` wins.
 */
export function attachLastReview(prs: ReviewPr[], sessions: SessionSummary[]): ReviewPrRow[] {
  return prs.map((pr) => {
    let last: SessionSummary | null = null;
    for (const s of sessions) {
      const r = s.review;
      if (r === undefined || r.owner !== pr.owner || r.repo !== pr.repo || r.pr !== pr.number) continue;
      if (last === null || s.createdAt > last.createdAt) last = s;
    }
    return {
      ...pr,
      lastReview:
        last === null
          ? null
          : {
              sessionId: last.id,
              ts: last.createdAt,
              state: last.state,
              ...(last.outcome !== undefined ? { outcome: last.outcome } : {}),
              // MC-R4: verdict + severity counts ride the row so the list can
              // say "request-changes · 3 findings" without opening the session.
              ...(last.findings !== undefined ? { findings: toLastReviewFindings(last.findings) } : {}),
            },
    };
  });
}

function toLastReviewFindings(findings: SessionSummary['findings']): LastReviewFindings | null {
  if (findings === undefined || findings === null) return null;
  return {
    verdict: findings.verdict,
    counts: severityCounts(findings.findings),
    total: findings.findings.length,
  };
}

const SEARCH_QUERY = `query($q:String!){
  search(query:$q, type:ISSUE, first:50){
    nodes{
      ... on PullRequest{
        number title headRefName updatedAt additions deletions
        author{login} repository{name owner{login}}
      }
    }
  }
}`;

interface SearchNode {
  number?: number;
  title?: string;
  headRefName?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  author?: { login?: string } | null;
  repository?: { name?: string; owner?: { login?: string } };
}

/** Open PRs across `org` plus `user`'s personal repos (when given), newest
 * activity first. Throws when gh fails. */
export async function listOpenPrs(gh: GhRunner, org: string, user?: string): Promise<ReviewPr[]> {
  const scope = user !== undefined && user !== '' ? `org:${org} user:${user}` : `org:${org}`;
  const stdout = await gh([
    'api',
    'graphql',
    '-f',
    `query=${SEARCH_QUERY}`,
    '-f',
    `q=${scope} is:pr is:open`,
  ]);
  const parsed = JSON.parse(stdout) as {
    data?: { search?: { nodes?: SearchNode[] } };
  };
  const nodes = parsed.data?.search?.nodes ?? [];
  return nodes
    .filter(
      (n) =>
        typeof n.number === 'number' &&
        typeof n.repository?.name === 'string' &&
        typeof n.repository?.owner?.login === 'string',
    )
    .map((n) => ({
      owner: n.repository!.owner!.login!,
      repo: n.repository!.name!,
      number: n.number!,
      title: n.title ?? '',
      author: n.author?.login ?? '',
      branch: n.headRefName ?? '',
      updatedAt: n.updatedAt ?? '',
      additions: typeof n.additions === 'number' ? n.additions : 0,
      deletions: typeof n.deletions === 'number' ? n.deletions : 0,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
