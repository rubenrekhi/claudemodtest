import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'pull-requests',
  props: {
    title: 'Pull Requests',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PR_NODE = {
  id: 'PR_node_1',
  number: 7,
  title: 'Add dark mode',
  url: 'https://github.com/octo/app/pull/7',
  isDraft: false,
  createdAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  additions: 12,
  deletions: 3,
  changedFiles: 1,
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  baseRefName: 'main',
  headRefName: 'dark-mode',
  author: { login: 'friend' },
  repository: { nameWithOwner: 'octo/app' },
  labels: { nodes: [{ name: 'ui' }] },
  comments: { totalCount: 2 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
}

const res = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })
const ok = (body: unknown) => res(200, JSON.stringify(body))

test('lists, opens, summarizes and merges a pull request', async ($, on) => {
  const calls: string[] = []
  const prompts: string[] = []
  let isMerged = false

  on('env.get', (_$, e) => ({ value: e.name === 'GITHUB_TOKEN' ? 'test-token' : undefined }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('ui.status', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: '**Looks good.** Adds a theme toggle.',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('http.fetch', (_$, e) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('https://api.github.com', '')
    calls.push(`${method} ${path}`)
    expect(e.init?.headers?.Authorization).toBe('Bearer test-token')

    if (path === '/graphql') {
      const body = JSON.parse(e.init?.body ?? '{}')
      if (body.query.includes('viewer')) return ok({ data: { viewer: { login: 'me' } } })
      return ok({ data: { search: { nodes: isMerged ? [] : [PR_NODE] } } })
    }
    if (path === '/repos/octo/app/pulls/7' && e.init?.headers?.Accept?.includes('diff')) {
      return res(200, 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n')
    }
    if (path === '/repos/octo/app/pulls/7') {
      return ok({ body: 'Adds **dark mode**.', head: { sha: 'abc123' }, mergeable_state: 'clean' })
    }
    if (path.startsWith('/repos/octo/app/pulls/7/files')) {
      return ok([{ filename: 'src/theme.ts', status: 'modified', additions: 12, deletions: 3, patch: '@@ -1,2 +1,2 @@\n-const dark = false\n+const dark = true\n context' }])
    }
    if (path.startsWith('/repos/octo/app/pulls/7/reviews')) {
      return ok([{ user: { login: 'friend2' }, state: 'APPROVED' }])
    }
    if (path.startsWith('/repos/octo/app/commits/abc123/check-runs')) {
      return ok({ check_runs: [{ name: 'test', conclusion: 'success', html_url: 'https://ci.example/1' }] })
    }
    if (path === '/repos/octo/app/commits/abc123/status') return ok({ statuses: [] })
    if (method === 'PUT' && path === '/repos/octo/app/pulls/7/merge') {
      isMerged = true
      return ok({ merged: true, message: 'Pull Request successfully merged' })
    }
    return res(404, '{"message":"Not Found"}')
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    isMerged = false
    calls.length = 0
    const ui = await $.ui.mount({ plugin: 'pull-requests', surface, ...PANE })

    // List view.
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: 'open-octo/app#7' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /approved/ })).toBeDefined()

    // Search filters the list.
    await ui.input({ key: 'search', text: 'nothing-like-this' })
    expect(await ui.find({ key: 'open-octo/app#7' })).toBeUndefined()
    await ui.input({ key: 'search', text: 'dark' })
    expect(await ui.find({ key: 'open-octo/app#7' })).toBeDefined()

    // Detail view: checks, files, diff.
    await ui.press({ key: 'open-octo/app#7' })
    expect(await ui.find({ type: 'Markdown', key: 'body' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /friend2: approved/ })).toBeDefined()
    await ui.press({ key: 'toggle-src/theme.ts' })
    expect(JSON.stringify(await ui.drawn())).toContain('"format":"diff"')

    // Claude summary drawn in the pane, and a review sent to the chat.
    await ui.press({ key: 'summarize' })
    expect(await ui.find({ type: 'Markdown', key: 'summary' })).toBeDefined()
    await ui.press({ key: 'ask-review' })
    expect(prompts.at(-1)).toContain('octo/app#7')

    // Merge needs a second press, then lands back on the list.
    await ui.press({ key: 'merge' })
    expect(calls.some(call => call.startsWith('PUT'))).toBe(false)
    await ui.press({ key: 'confirm-merge' })
    expect(calls).toContain('PUT /repos/octo/app/pulls/7/merge')
    expect(await ui.find({ key: 'open-octo/app#7' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /no longer open/ })).toBeDefined()

    await ui.unmount()
  }
})

test('the band comes back with the list after /clear', async ($, on) => {
  on('env.get', (_$, e) => ({ value: e.name === 'GITHUB_TOKEN' ? 'test-token' : undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  // Stands in for the engine's own (empty) band when the mod has nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  on('http.fetch', (_$, e) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    if (body.query?.includes('viewer')) return ok({ data: { viewer: { login: 'me' } } })
    return ok({ data: { search: { nodes: [PR_NODE] } } })
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({
      plugin: 'pull-requests',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    })
    await $.classic.SessionStart({ source: 'clear' })
    expect((await band.find({ key: 'open-prs' }))?.props.label).toBe('⇄ Pull Requests (1)')
    expect(await band.find({ type: 'Text', text: /1 ready to merge/ })).toBeDefined()
    await band.unmount()
  }
})
