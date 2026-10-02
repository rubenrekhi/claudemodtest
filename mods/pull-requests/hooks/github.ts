import type {
  PrCheckRun,
  PrChecks,
  PrDetail,
  PrFile,
  PrFilter,
  PrMergeMethod,
  PrReview,
  PrReviewDecision,
  PrSummary,
} from '../types'

type Json = any

/**
 * One GitHub API call: the hooks module owns the network (and `$`), this file
 * owns what to ask and how to read the answer. Resolves the body as text and
 * rejects with GitHub's own message on a non-2xx.
 */
export type GitHubRequest = (method: string, path: string, body?: unknown, accept?: string) => Promise<string>

export const API = 'https://api.github.com'

export function errorText(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as Json
    const detail = Array.isArray(parsed.errors)
      ? parsed.errors.map((one: Json) => one.message ?? one).join('; ')
      : ''
    return `GitHub ${status}: ${parsed.message ?? text}${detail ? ` (${detail})` : ''}`
  } catch {
    return `GitHub ${status}: ${text.slice(0, 200)}`
  }
}

async function rest(req: GitHubRequest, method: string, path: string, body?: unknown): Promise<Json> {
  const text = await req(method, path, body)
  return text === '' ? null : JSON.parse(text)
}

async function graphql(req: GitHubRequest, query: string, variables: Record<string, unknown> = {}): Promise<Json> {
  const out = await rest(req, 'POST', '/graphql', { query, variables })
  if (out?.errors?.length) {
    throw new Error(`GitHub: ${out.errors.map((one: Json) => one.message).join('; ')}`)
  }
  return out.data
}

export async function viewerLogin(req: GitHubRequest): Promise<string> {
  const data = await graphql(req, 'query { viewer { login } }')
  return data.viewer.login
}

const SEARCH = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        id number title url isDraft createdAt updatedAt
        additions deletions changedFiles reviewDecision mergeable
        baseRefName headRefName
        author { login }
        repository { nameWithOwner }
        labels(first: 6) { nodes { name } }
        comments { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

export function searchQuery(filter: PrFilter, login: string): string {
  const base = 'is:pr is:open archived:false sort:updated-desc'
  switch (filter) {
    case 'repos':
      return `${base} user:${login}`
    case 'authored':
      return `${base} author:@me`
    case 'review':
      return `${base} review-requested:@me`
    case 'involved':
      return `${base} involves:@me`
  }
}

function checksOf(state: string | undefined): PrChecks {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

export async function listPrs(req: GitHubRequest, filter: PrFilter, login: string): Promise<PrSummary[]> {
  const data = await graphql(req, SEARCH, { q: searchQuery(filter, login) })

  return (data.search.nodes as Json[])
    .filter(node => node && node.number !== undefined)
    .map(
      (node): PrSummary => ({
        id: node.id,
        key: `${node.repository.nameWithOwner}#${node.number}`,
        repo: node.repository.nameWithOwner,
        number: node.number,
        title: node.title,
        author: node.author?.login ?? 'ghost',
        url: node.url,
        isDraft: node.isDraft,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFiles,
        comments: node.comments.totalCount,
        reviewDecision: (node.reviewDecision ?? 'NONE') as PrReviewDecision,
        checks: checksOf(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
        mergeable: node.mergeable,
        baseRef: node.baseRefName,
        headRef: node.headRefName,
        labels: node.labels.nodes.map((label: Json) => label.name),
      }),
    )
}

export async function prDetail(req: GitHubRequest, pr: PrSummary): Promise<PrDetail> {
  const base = `/repos/${pr.repo}`
  const [pull, files, reviews] = await Promise.all([
    rest(req, 'GET', `${base}/pulls/${pr.number}`),
    rest(req, 'GET', `${base}/pulls/${pr.number}/files?per_page=100`),
    rest(req, 'GET', `${base}/pulls/${pr.number}/reviews?per_page=100`),
  ])
  const sha: string = pull.head.sha
  const [runs, statuses] = await Promise.all([
    rest(req, 'GET', `${base}/commits/${sha}/check-runs?per_page=100`).catch(() => null),
    rest(req, 'GET', `${base}/commits/${sha}/status`).catch(() => null),
  ])

  const checks: PrCheckRun[] = [
    ...((runs?.check_runs ?? []) as Json[]).map(run => ({
      name: run.name,
      state: run.conclusion ?? (run.status === 'completed' ? 'neutral' : 'pending'),
      url: run.html_url ?? undefined,
    })),
    ...((statuses?.statuses ?? []) as Json[]).map(status => ({
      name: status.context,
      state: status.state === 'error' ? 'failure' : status.state,
      url: status.target_url ?? undefined,
    })),
  ]

  // The latest decisive review per person (a later comment does not undo an approval).
  const latest = new Map<string, PrReview>()
  for (const review of reviews as Json[]) {
    const author = review.user?.login ?? 'ghost'
    if (review.state !== 'COMMENTED' || !latest.has(author)) {
      latest.set(author, { author, state: review.state })
    }
  }

  return {
    key: pr.key,
    body: pull.body ?? '',
    headSha: sha,
    mergeableState: pull.mergeable_state ?? 'unknown',
    files: (files as Json[]).map(
      (file): PrFile => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(typeof file.patch === 'string' ? { patch: file.patch } : {}),
      }),
    ),
    checks,
    reviews: [...latest.values()],
  }
}

export async function prDiff(req: GitHubRequest, pr: PrSummary): Promise<string> {
  return req('GET', `/repos/${pr.repo}/pulls/${pr.number}`, undefined, 'application/vnd.github.v3.diff')
}

export async function mergePr(req: GitHubRequest, pr: PrSummary, method: PrMergeMethod): Promise<string> {
  const out = await rest(req, 'PUT', `/repos/${pr.repo}/pulls/${pr.number}/merge`, { merge_method: method })
  return out?.message ?? 'Merged.'
}

export async function reviewPr(
  req: GitHubRequest,
  pr: PrSummary,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string,
): Promise<void> {
  await rest(req, 'POST', `/repos/${pr.repo}/pulls/${pr.number}/reviews`, body ? { event, body } : { event })
}

export async function commentPr(req: GitHubRequest, pr: PrSummary, body: string): Promise<void> {
  await rest(req, 'POST', `/repos/${pr.repo}/issues/${pr.number}/comments`, { body })
}

export async function closePr(req: GitHubRequest, pr: PrSummary): Promise<void> {
  await rest(req, 'PATCH', `/repos/${pr.repo}/pulls/${pr.number}`, { state: 'closed' })
}

export async function updateBranch(req: GitHubRequest, pr: PrSummary): Promise<void> {
  await rest(req, 'PUT', `/repos/${pr.repo}/pulls/${pr.number}/update-branch`, {})
}

export async function markReady(req: GitHubRequest, pr: PrSummary): Promise<void> {
  await graphql(
    req,
    'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }',
    { id: pr.id },
  )
}
