import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PrChecks, PrDetail, PrFilter, PrLoad, PrMergeMethod, PrSummary, PrView } from '../types'
import {
  API,
  closePr,
  commentPr,
  errorText,
  listPrs,
  markReady,
  mergePr,
  prDetail,
  prDiff,
  reviewPr,
  updateBranch,
  viewerLogin,
} from './github'
import type { GitHubRequest } from './github'
import { checkoutPrompt, fixCiPrompt, reviewPrompt, summaryPrompt } from './prompts'

type $ = EngineInterface

const PANE = 'pull-requests'
const TITLE = 'Pull Requests'
const REFRESH_MS = 5 * 60_000

const login = atom({ plugin: 'pull-requests', key: 'login' } as const, null)
const prs = atom({ plugin: 'pull-requests', key: 'prs' } as const, [])
const load = atom({ plugin: 'pull-requests', key: 'load' } as const, { isLoading: false, error: null, fetchedAt: null })
const filter = atom({ plugin: 'pull-requests', key: 'filter' } as const, 'repos')
const query = atom({ plugin: 'pull-requests', key: 'query' } as const, '')
const view = atom({ plugin: 'pull-requests', key: 'view' } as const, { kind: 'list' })
const detail = atom({ plugin: 'pull-requests', key: 'detail' } as const, null)
const isDetailLoading = atom({ plugin: 'pull-requests', key: 'isDetailLoading' } as const, false)
const openFiles = atom({ plugin: 'pull-requests', key: 'openFiles' } as const, [])
const mergeMethod = atom({ plugin: 'pull-requests', key: 'mergeMethod' } as const, 'squash')
const draft = atom({ plugin: 'pull-requests', key: 'draft' } as const, '')
const confirm = atom({ plugin: 'pull-requests', key: 'confirm' } as const, null)
const notice = atom({ plugin: 'pull-requests', key: 'notice' } as const, null)
const summaries = atom({ plugin: 'pull-requests', key: 'summaries' } as const, {})
const summarizing = atom({ plugin: 'pull-requests', key: 'summarizing' } as const, null)
const isBandHidden = atom({ plugin: 'pull-requests', key: 'isBandHidden' } as const, false)

const FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'repos', label: 'My repos' },
  { id: 'review', label: 'Review requested' },
  { id: 'authored', label: 'Authored' },
  { id: 'involved', label: 'Involved' },
]

const FILTER_ALIASES: Record<string, PrFilter> = {
  repos: 'repos',
  mine: 'repos',
  review: 'review',
  reviews: 'review',
  authored: 'authored',
  author: 'authored',
  involved: 'involved',
  all: 'involved',
}

// ---------------------------------------------------------------- helpers

const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

const CHECK_GLYPH: Record<PrChecks, { glyph: string; color?: string; label: string }> = {
  success: { glyph: '✓', color: 'green', label: 'checks pass' },
  failure: { glyph: '✗', color: 'red', label: 'checks fail' },
  pending: { glyph: '●', color: 'yellow', label: 'checks running' },
  none: { glyph: '·', label: 'no checks' },
}

function reviewLabel(pr: PrSummary): { text: string; color?: string } | null {
  switch (pr.reviewDecision) {
    case 'APPROVED':
      return { text: 'approved', color: 'green' }
    case 'CHANGES_REQUESTED':
      return { text: 'changes requested', color: 'red' }
    case 'REVIEW_REQUIRED':
      return { text: 'review required', color: 'yellow' }
    default:
      return null
  }
}

function matches(pr: PrSummary, text: string): boolean {
  if (text === '') return true
  const needle = text.toLowerCase()
  return [pr.title, pr.repo, pr.author, pr.headRef, `#${pr.number}`, ...pr.labels].some(field =>
    field.toLowerCase().includes(needle),
  )
}

async function current($: $): Promise<PrSummary | null> {
  const v = await read($, view)
  if (v.kind !== 'pr') return null
  return (await read($, prs)).find(pr => pr.key === v.key) ?? null
}

async function say($: $, text: string | null) {
  await update($, notice, () => text)
}

// ---------------------------------------------------------------- GitHub

const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

// Kept for one load of the module; a reload (or `/prs refresh`) asks again.
let token: string | null = null

/**
 * GITHUB_TOKEN / GH_TOKEN when set, else what `gh auth login` stored. The
 * desktop app's PATH often lacks Homebrew, so the usual places are tried.
 */
async function getToken($: $): Promise<string> {
  if (token !== null) return token

  const fromEnv = (await $.env.get('GITHUB_TOKEN')) || (await $.env.get('GH_TOKEN'))
  if (fromEnv) return (token = fromEnv.trim())

  for (const bin of GH_PATHS) {
    try {
      const ran = await $.process.run([bin, 'auth', 'token'], { timeoutMs: 10_000 })
      const out = ran.stdout.trim()
      if (ran.exitCode === 0 && out !== '') return (token = out)
    } catch {
      // not installed at this path
    }
  }

  throw new Error('No GitHub login found. Install the GitHub CLI and run `gh auth login`, or set GITHUB_TOKEN.')
}

/** The one door to the GitHub API, handed to the request builders in ./github. */
function gh($: $): GitHubRequest {
  return async (method, path, body, accept) => {
    const auth = await getToken($)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth}`,
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-code-pull-requests-mod',
    }
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    const res = await $.http.fetch(`${API}${path}`, init)
    if (res.status === 401) token = null
    if (!res.ok) throw new Error(errorText(res.status, res.text))

    return res.text
  }
}

// ---------------------------------------------------------------- data

async function ensureLogin($: $): Promise<string> {
  const known = await read($, login)
  if (known !== null) return known
  const name = await viewerLogin(gh($))
  await update($, login, () => name)
  return name
}

async function refresh($: $, options: { isQuiet?: boolean } = {}) {
  await update($, load, l => ({ ...l, isLoading: true, error: null }))
  try {
    const me = await ensureLogin($)
    const which = await read($, filter)
    const before = new Set((await read($, prs)).map(pr => pr.key))
    const list = await listPrs(gh($), which, me)
    await update($, prs, () => list)
    await update($, load, (): PrLoad => ({ isLoading: false, error: null, fetchedAt: Date.now() }))
    $.ui.status(`⇄ ${list.length} open PR${list.length === 1 ? '' : 's'}`)

    const fresh = list.filter(pr => !before.has(pr.key))
    if (options.isQuiet && before.size > 0 && fresh.length > 0) {
      $.ui.toast(
        fresh.length === 1
          ? `New PR: ${fresh[0]!.repo}#${fresh[0]!.number} ${fresh[0]!.title}`
          : `${fresh.length} new pull requests`,
      )
    }
  } catch (err) {
    await update($, load, l => ({ ...l, isLoading: false, error: errorOf(err) }))
  }
}

async function openPr($: $, pr: PrSummary) {
  await update($, view, (): PrView => ({ kind: 'pr', key: pr.key }))
  await update($, detail, () => null)
  await update($, openFiles, () => [])
  await update($, confirm, () => null)
  await update($, draft, () => '')
  await say($, null)
  await loadDetail($, pr)
}

async function loadDetail($: $, pr: PrSummary) {
  await update($, isDetailLoading, () => true)
  try {
    const got = await prDetail(gh($), pr)
    const v = await read($, view)
    if (v.kind === 'pr' && v.key === pr.key) {
      await update($, detail, (): PrDetail => got)
    }
  } catch (err) {
    await say($, `Could not load ${pr.key}: ${errorOf(err)}`)
  } finally {
    await update($, isDetailLoading, () => false)
  }
}

async function back($: $) {
  await update($, view, (): PrView => ({ kind: 'list' }))
  await update($, detail, () => null)
  await update($, confirm, () => null)
  await say($, null)
}

/** Runs one GitHub action, reports it, and refreshes what it changed. */
async function act($: $, pr: PrSummary, label: string, run: () => Promise<string | void>) {
  await update($, confirm, () => null)
  await say($, `${label}…`)
  try {
    const message = await run()
    await say($, `✓ ${message ?? label}`)
    $.ui.toast(`${pr.repo}#${pr.number}: ${message ?? label}`)
  } catch (err) {
    await say($, `✗ ${label} failed: ${errorOf(err)}`)
    return
  }
  await refresh($)
  if ((await read($, prs)).some(one => one.key === pr.key)) {
    await loadDetail($, pr)
  } else {
    await back($)
    await say($, `✓ ${pr.repo}#${pr.number} is no longer open`)
  }
}

async function summarize($: $, pr: PrSummary) {
  await update($, summarizing, () => pr.key)
  try {
    const diff = await prDiff(gh($), pr)
    const answer = await $.model.complete({
      model: await $.session.model(),
      prompt: summaryPrompt(pr, diff),
      maxTokens: 700,
      timeoutMs: 90_000,
    })
    const text = answer.isAnswered ? answer.text : `Claude could not summarize this (${answer.reason}).`
    await update($, summaries, all => ({ ...all, [pr.key]: text }))
  } catch (err) {
    await say($, `✗ Summary failed: ${errorOf(err)}`)
  } finally {
    await update($, summarizing, () => null)
  }
}

async function askClaude($: $, text: string, what: string) {
  await $.prompt.submit({ text })
  await say($, `Sent to Claude: ${what}. The answer appears in this chat.`)
}

async function openPane($: $) {
  await $.ui.open({ id: PANE, title: TITLE })
  const l = await read($, load)
  if (l.fetchedAt === null && !l.isLoading) {
    void refresh($)
  }
}

// ---------------------------------------------------------------- module

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Open the Pull Requests page (optionally: repos, review, authored, involved, refresh)',
      argumentHint: '[repos|review|authored|involved|refresh]',
    })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($, { isQuiet: true }))

    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'refresh') {
      token = null
      await refresh($)
    } else if (FILTER_ALIASES[arg]) {
      await update($, filter, () => FILTER_ALIASES[arg]!)
      await back($)
      await refresh($)
    }
    await openPane($)
    const l = await read($, load)

    return { text: l.error ? `Pull Requests: ${l.error}` : 'Pull Requests opened.' }
  })

  // The entry point: one quiet row above the prompt, the Code tab's "nav item".
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    const l = await read($, load)
    if (e.props.hasSurvey || (await read($, isBandHidden)) || (list.length === 0 && l.error === null)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const failing = list.filter(pr => pr.checks === 'failure').length
    const approved = list.filter(pr => pr.reviewDecision === 'APPROVED').length

    return (
      <Box flexDirection="row" gap={1}>
        <Button key="open-prs" label={`⇄ Pull Requests (${list.length})`} onPress={() => openPane($)} />
        {l.error !== null && <Text color="red" wrap="truncate-end">{l.error}</Text>}
        {approved > 0 && <Text color="green">{approved} ready to merge</Text>}
        {failing > 0 && <Text color="red">{failing} failing</Text>}
        <Button key="hide-prs" label="×" plain dimColor onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // The page needs text fields and pickers, which the mobile app does not draw yet.
    if (e.surface === 'mobile') return next(e)
    const { Box, Button, Text, Input, Select, Code, Markdown, Link } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const v = await read($, view)
    const l = await read($, load)
    const list = await read($, prs)
    const msg = await read($, notice)
    const now = Date.now()

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>⇄ Pull Requests</Text>
        <Button
          key="refresh"
          label={l.isLoading ? 'Refreshing…' : '↻ Refresh'}
          plain
          onPress={() => refresh($)}
        />
      </Box>
    )
    const noticeRow = msg !== null && (
      <Text color={msg.startsWith('✗') ? 'red' : msg.startsWith('✓') ? 'green' : undefined} wrap="wrap">
        {msg}
      </Text>
    )

    // ---------------------------------------------------- list view
    if (v.kind === 'list') {
      const which = await read($, filter)
      const text = await read($, query)
      const shown = list.filter(pr => matches(pr, text))

      return (
        <Box flexDirection="column" gap={1} width={width}>
          {header}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {FILTERS.map(f => (
              <Button
                key={`filter-${f.id}`}
                label={f.label}
                variant={f.id === which ? 'primary' : 'secondary'}
                onPress={async () => {
                  await update($, filter, () => f.id)
                  await refresh($)
                }}
              />
            ))}
          </Box>
          <Input
            key="search"
            placeholder="Filter by title, repo, author, branch, label…"
            value={text}
            onInput={(value: string) => update($, query, () => value)}
            onSubmit={(value: string) => update($, query, () => value)}
          />
          {noticeRow}
          {l.error !== null && <Text color="red" wrap="wrap">{l.error}</Text>}
          {l.isLoading && list.length === 0 && <Text dimColor>Loading your pull requests…</Text>}
          {!l.isLoading && l.error === null && shown.length === 0 && (
            <Text dimColor>{list.length === 0 ? 'No open pull requests here. 🎉' : 'Nothing matches that filter.'}</Text>
          )}
          {shown.length > 0 && (
            <Text dimColor>
              {shown.length} open{l.fetchedAt !== null ? ` · updated ${ago(new Date(l.fetchedAt).toISOString(), now)} ago` : ''}
            </Text>
          )}
          <Box flexDirection="column" gap={1}>
            {shown.map(pr => {
              const check = CHECK_GLYPH[pr.checks]
              const review = reviewLabel(pr)
              return (
                <Box key={`row-${pr.key}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text color={check.color}>{check.glyph}</Text>
                    <Button key={`open-${pr.key}`} label={pr.title} plain onPress={() => openPr($, pr)} />
                  </Box>
                  <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2}>
                    <Text dimColor>
                      {pr.repo}#{pr.number} · @{pr.author} · {ago(pr.updatedAt, now)}
                    </Text>
                    <Text color="green">+{pr.additions}</Text>
                    <Text color="red">−{pr.deletions}</Text>
                    {pr.isDraft && <Text dimColor>draft</Text>}
                    {review !== null && <Text color={review.color}>{review.text}</Text>}
                    {pr.mergeable === 'CONFLICTING' && <Text color="red">conflicts</Text>}
                    {pr.comments > 0 && <Text dimColor>💬 {pr.comments}</Text>}
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }

    // ---------------------------------------------------- PR view
    const pr = list.find(one => one.key === v.key)
    if (pr === undefined) {
      return (
        <Box flexDirection="column" gap={1} width={width}>
          {header}
          <Text dimColor>That pull request is no longer in the list.</Text>
          <Button key="back" label="← Back" onPress={() => back($)} />
        </Box>
      )
    }

    const d = await read($, detail)
    const isLoading = await read($, isDetailLoading)
    const files = await read($, openFiles)
    const method = await read($, mergeMethod)
    const body = await read($, draft)
    const pending = await read($, confirm)
    const summary = (await read($, summaries))[pr.key]
    const isSummarizing = (await read($, summarizing)) === pr.key
    const check = CHECK_GLYPH[pr.checks]
    const review = reviewLabel(pr)
    const canMerge = !pr.isDraft && pr.mergeable !== 'CONFLICTING'

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key="back" label="← All pull requests" plain onPress={() => back($)} />
          <Link href={pr.url} label="Open on GitHub ↗" />
        </Box>

        <Box flexDirection="column">
          <Text bold wrap="wrap">{pr.title}</Text>
          <Text dimColor wrap="wrap">
            {pr.repo}#{pr.number} · @{pr.author} · {pr.baseRef} ← {pr.headRef} · opened {ago(pr.createdAt, now)} ago
          </Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text color={check.color}>
              {check.glyph} {check.label}
            </Text>
            {review !== null && <Text color={review.color}>· {review.text}</Text>}
            {pr.isDraft && <Text dimColor>· draft</Text>}
            {pr.mergeable === 'CONFLICTING' && <Text color="red">· merge conflicts</Text>}
            <Text dimColor>· {pr.changedFiles} files</Text>
            <Text color="green">+{pr.additions}</Text>
            <Text color="red">−{pr.deletions}</Text>
          </Box>
          {pr.labels.length > 0 && <Text dimColor>🏷 {pr.labels.join(', ')}</Text>}
        </Box>

        {noticeRow}

        {/* Claude */}
        <Box flexDirection="column">
          <Text bold>Claude</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button
              key="summarize"
              label={isSummarizing ? 'Summarizing…' : summary ? '✨ Re-summarize' : '✨ Summarize'}
              variant="primary"
              onPress={() => summarize($, pr)}
            />
            <Button key="ask-review" label="Review in chat" onPress={() => askClaude($, reviewPrompt(pr), 'review')} />
            {pr.checks === 'failure' && (
              <Button key="ask-fix" label="Fix failing CI" onPress={() => askClaude($, fixCiPrompt(pr), 'fix CI')} />
            )}
            <Button
              key="ask-checkout"
              label="Check out here"
              onPress={() => askClaude($, checkoutPrompt(pr), 'check out')}
            />
            <Button
              key="new-chat"
              label="Copy for new chat"
              onPress={async press => {
                const copied = await $.ui.copy({ text: reviewPrompt(pr), surface: press.surface })
                await say(
                  $,
                  copied.isCopied
                    ? 'Review prompt copied: start a new session and paste it.'
                    : 'Could not reach the clipboard; the prompt was put in the prompt box instead.',
                )
                if (!copied.isCopied) await $.prompt.fill({ text: reviewPrompt(pr) })
              }}
            />
          </Box>
          {summary !== undefined && (
            <Box borderStyle="round" paddingX={1} marginTop={1}>
              <Markdown key="summary" text={summary} />
            </Box>
          )}
        </Box>

        {/* Review & merge */}
        <Box flexDirection="column" gap={1}>
          <Text bold>Review</Text>
          <Input
            key="draft"
            placeholder="Write a comment or review (Enter posts a comment)…"
            value={body}
            submitLabel="Comment"
            onInput={(value: string) => update($, draft, () => value)}
            onSubmit={async (value: string) => {
              if (value.trim() === '') return say($, 'Write something first.')
              await act($, pr, 'Commented', () => commentPr(gh($), pr, value))
              await update($, draft, () => '')
            }}
          />
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button
              key="approve"
              label="✓ Approve"
              onPress={async () => {
                await act($, pr, 'Approved', () => reviewPr(gh($), pr, 'APPROVE', body))
                await update($, draft, () => '')
              }}
            />
            <Button
              key="request-changes"
              label="Request changes"
              onPress={async () => {
                if (body.trim() === '') return say($, 'Say what needs to change in the box first.')
                await act($, pr, 'Requested changes', () => reviewPr(gh($), pr, 'REQUEST_CHANGES', body))
                await update($, draft, () => '')
              }}
            />
            {pr.isDraft && (
              <Button key="ready" label="Ready for review" onPress={() => act($, pr, 'Marked ready', () => markReady(gh($), pr))} />
            )}
            {(d?.mergeableState === 'behind' || pr.mergeable === 'CONFLICTING') && (
              <Button key="update-branch" label="Update branch" onPress={() => act($, pr, 'Branch updated', () => updateBranch(gh($), pr))} />
            )}
          </Box>

          <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
            <Select
              key="merge-method"
              label="Merge method"
              value={method}
              options={[
                { value: 'squash', label: 'Squash and merge' },
                { value: 'merge', label: 'Create a merge commit' },
                { value: 'rebase', label: 'Rebase and merge' },
              ]}
              onSelect={(value: string) => update($, mergeMethod, () => value as PrMergeMethod)}
            />
            {pending === 'merge' ? (
              <>
                <Button
                  key="confirm-merge"
                  label={`Confirm: ${method} into ${pr.baseRef}`}
                  variant="primary"
                  onPress={() => act($, pr, 'Merged', () => mergePr(gh($), pr, method))}
                />
                <Button key="cancel-merge" label="Cancel" onPress={() => update($, confirm, () => null)} />
              </>
            ) : (
              <Button
                key="merge"
                label="⇢ Merge"
                variant={canMerge && pr.checks !== 'failure' ? 'primary' : 'secondary'}
                onPress={async () => {
                  if (!canMerge) {
                    return say($, pr.isDraft ? 'Drafts cannot be merged: mark it ready first.' : 'Resolve the merge conflicts first.')
                  }
                  await update($, confirm, () => 'merge')
                  if (pr.checks === 'failure') await say($, 'Heads up: checks are failing on this PR.')
                }}
              />
            )}
            {pending === 'close' ? (
              <>
                <Button key="confirm-close" label="Confirm close" onPress={() => act($, pr, 'Closed', () => closePr(gh($), pr))} />
                <Button key="cancel-close" label="Cancel" onPress={() => update($, confirm, () => null)} />
              </>
            ) : (
              <Button key="close" label="Close PR" dimColor onPress={() => update($, confirm, () => 'close')} />
            )}
          </Box>
        </Box>

        {isLoading && d === null && <Text dimColor>Loading description, checks and diff…</Text>}

        {d !== null && d.body.trim() !== '' && (
          <Box flexDirection="column">
            <Text bold>Description</Text>
            <Markdown key="body" text={d.body.length > 6000 ? `${d.body.slice(0, 6000)}\n\n…` : d.body} />
          </Box>
        )}

        {d !== null && d.reviews.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Reviews</Text>
            {d.reviews.map(r => (
              <Text
                key={`review-${r.author}`}
                color={r.state === 'APPROVED' ? 'green' : r.state === 'CHANGES_REQUESTED' ? 'red' : undefined}
              >
                @{r.author}: {r.state.toLowerCase().replace(/_/g, ' ')}
              </Text>
            ))}
          </Box>
        )}

        {d !== null && d.checks.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Checks</Text>
            {d.checks.map((c, i) => {
              const glyph =
                c.state === 'success' ? CHECK_GLYPH.success : c.state === 'failure' || c.state === 'timed_out' || c.state === 'cancelled' ? CHECK_GLYPH.failure : c.state === 'pending' ? CHECK_GLYPH.pending : CHECK_GLYPH.none
              return (
                <Box key={`check-${i}`} flexDirection="row" gap={1}>
                  <Text color={glyph.color}>{glyph.glyph}</Text>
                  {c.url ? <Link href={c.url} label={c.name} /> : <Text>{c.name}</Text>}
                  <Text dimColor>{c.state}</Text>
                </Box>
              )
            })}
          </Box>
        )}

        {d !== null && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>Files changed ({d.files.length})</Text>
              <Button
                key="toggle-all"
                label={files.length > 0 ? 'Collapse all' : 'Expand all'}
                plain
                onPress={() =>
                  update($, openFiles, open => (open.length > 0 ? [] : d.files.slice(0, 15).map(f => f.path)))
                }
              />
            </Box>
            {d.files.map(file => {
              const isOpen = files.includes(file.path)
              const tooBig = file.patch !== undefined && file.patch.length > 40_000
              return (
                <Box key={`file-${file.path}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key={`toggle-${file.path}`}
                      label={`${isOpen ? '▾' : '▸'} ${file.path}`}
                      plain
                      onPress={() =>
                        update($, openFiles, open =>
                          open.includes(file.path) ? open.filter(p => p !== file.path) : [...open, file.path],
                        )
                      }
                    />
                    <Text color="green">+{file.additions}</Text>
                    <Text color="red">−{file.deletions}</Text>
                    {file.status !== 'modified' && <Text dimColor>{file.status}</Text>}
                  </Box>
                  {isOpen && file.patch !== undefined && !tooBig && (
                    <Code source={file.patch} format="diff" path={file.path} />
                  )}
                  {isOpen && (file.patch === undefined || tooBig) && (
                    <Text dimColor>  No inline diff (binary or too large): see it on GitHub.</Text>
                  )}
                </Box>
              )
            })}
            {d.files.length >= 100 && <Text dimColor>Showing the first 100 files.</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
