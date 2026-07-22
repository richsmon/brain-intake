// MC-R1: open-PR listing across a GitHub org. One GraphQL search call via the
// gh CLI returns every field the app's review list needs (branch + additions/
// deletions included) — no per-PR follow-up requests.
import type { GhRunner } from './gh.js';

export interface ReviewPr {
  repo: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  updatedAt: string;
  additions: number;
  deletions: number;
}

const SEARCH_QUERY = `query($q:String!){
  search(query:$q, type:ISSUE, first:50){
    nodes{
      ... on PullRequest{
        number title headRefName updatedAt additions deletions
        author{login} repository{name}
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
  repository?: { name?: string };
}

/** Open PRs across `org`, newest activity first. Throws when gh fails. */
export async function listOpenPrs(gh: GhRunner, org: string): Promise<ReviewPr[]> {
  const stdout = await gh([
    'api',
    'graphql',
    '-f',
    `query=${SEARCH_QUERY}`,
    '-f',
    `q=org:${org} is:pr is:open`,
  ]);
  const parsed = JSON.parse(stdout) as {
    data?: { search?: { nodes?: SearchNode[] } };
  };
  const nodes = parsed.data?.search?.nodes ?? [];
  return nodes
    .filter((n) => typeof n.number === 'number' && typeof n.repository?.name === 'string')
    .map((n) => ({
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
