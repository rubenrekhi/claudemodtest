export type PrChecks = 'success' | 'failure' | 'pending' | 'none'

export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE'

export type PrSummary = {
  /** GraphQL node id, used by the ready-for-review mutation. */
  id: string
  /** `owner/repo#123`, the key every view and action uses. */
  key: string
  repo: string
  number: number
  title: string
  author: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  comments: number
  reviewDecision: PrReviewDecision
  checks: PrChecks
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  baseRef: string
  headRef: string
  labels: string[]
}

export type PrFile = {
  path: string
  status: string
  additions: number
  deletions: number
  /** Unified-diff hunks; absent for binary or very large files. */
  patch?: string
}

export type PrCheckRun = {
  name: string
  /** `success`, `failure`, `pending`, `skipped`, ... */
  state: string
  url?: string
}

export type PrReview = { author: string; state: string }

export type PrDetail = {
  key: string
  body: string
  headSha: string
  mergeableState: string
  files: PrFile[]
  checks: PrCheckRun[]
  reviews: PrReview[]
}

export type PrFilter = 'repos' | 'authored' | 'review' | 'involved'

export type PrMergeMethod = 'squash' | 'merge' | 'rebase'

export type PrView = { kind: 'list' } | { kind: 'pr'; key: string }

export type PrLoad = {
  isLoading: boolean
  error: string | null
  /** Epoch ms of the last successful list fetch. */
  fetchedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'pull-requests': {
      login: string | null
      prs: PrSummary[]
      load: PrLoad
      filter: PrFilter
      query: string
      view: PrView
      detail: PrDetail | null
      isDetailLoading: boolean
      /** Paths whose diff is expanded in the detail view. */
      openFiles: string[]
      mergeMethod: PrMergeMethod
      /** The text typed into the review box. */
      draft: string
      /** A destructive action awaiting its second press: `merge` or `close`. */
      confirm: string | null
      /** One line of feedback after an action. */
      notice: string | null
      /** Claude's summaries, by PR key. */
      summaries: Record<string, string>
      summarizing: string | null
      isBandHidden: boolean
    }
  }
}
