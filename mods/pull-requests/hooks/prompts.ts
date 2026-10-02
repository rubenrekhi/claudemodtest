import type { PrSummary } from '../types'

const ref = (pr: PrSummary) => `${pr.repo}#${pr.number} ("${pr.title}", ${pr.url})`

/** Sent into the current chat: Claude fetches and reviews the PR itself. */
export function reviewPrompt(pr: PrSummary): string {
  return [
    `Review pull request ${ref(pr)}.`,
    `It merges \`${pr.headRef}\` into \`${pr.baseRef}\` and was opened by @${pr.author}.`,
    'Fetch it with the GitHub tools you have (the GitHub MCP server, or `gh pr view` / `gh pr diff`).',
    'Read the full diff, then report: what the change does, correctness bugs (with file:line),',
    'risky or missing tests, and anything that should block merging. Rank findings by severity.',
    'Do not post anything to GitHub unless I ask.',
  ].join(' ')
}

/** Sent into the current chat when checks fail. */
export function fixCiPrompt(pr: PrSummary): string {
  return [
    `CI is failing on pull request ${ref(pr)}.`,
    'Look at the failing checks and their logs, find the root cause,',
    `and propose a fix. If the repository is checked out here, check out \`${pr.headRef}\`,`,
    'make the fix and run the relevant tests, but ask before pushing.',
  ].join(' ')
}

/** Checks the branch out here so Claude can work on it. */
export function checkoutPrompt(pr: PrSummary): string {
  return [
    `Check out pull request ${ref(pr)} locally (\`gh pr checkout ${pr.number} --repo ${pr.repo}\`),`,
    'summarize what it changes, and run its tests. Wait for my next instruction before editing.',
  ].join(' ')
}

/** For Claude's quick summary drawn inside the pane. */
export function summaryPrompt(pr: PrSummary, diff: string): string {
  const cut = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n[diff truncated]` : diff
  return [
    `Pull request ${pr.repo}#${pr.number}: ${pr.title}`,
    '',
    'Summarize this pull request for a reviewer in under 150 words of Markdown:',
    'a one-line verdict, then 3-5 bullets on what changed, then any red flags (bugs, missing tests, risky changes).',
    '',
    '```diff',
    cut,
    '```',
  ].join('\n')
}
