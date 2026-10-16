import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Card, Project } from '../types'
import { cardPrompt, isWithin, mergePrompt, reposFor, worktreeFor } from '../hooks/model'

const ws: Project = {
  id: 'pws',
  name: 'IdeaJudge 2026',
  type: 'workspace',
  path: '/development/ideajudge-2026',
  baseBranch: '',
  repos: [
    { name: 'ideajudge-services', baseBranch: 'main' },
    { name: 'ideajudge-ui', baseBranch: 'develop' },
  ],
  maxParallel: 2,
  testCommand: '',
  colour: 'cyan',
  createdAt: 1,
}
const card = (id: string, over: Partial<Card>): Card => ({
  id,
  projectId: 'pws',
  title: `Card ${id}`,
  brief: `Brief for ${id}`,
  acceptance: [],
  notes: [],
  mode: 'sequential',
  column: 'queued',
  rank: 0,
  history: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})
const CARD_DIR = '/development/.kanbot-worktrees/ideajudge-2026'

describe('workspace model', () => {
  test('folders match across Windows and POSIX spellings', () => {
    expect(isWithin('C:\\development\\ideajudge-2026\\ideajudge-ui', '/development/ideajudge-2026')).toBe(true)
    expect(isWithin('c:/Development/IdeaJudge-2026', 'C:\\development\\ideajudge-2026\\')).toBe(true)
    expect(isWithin('/development/ideajudge-2026-old', '/development/ideajudge-2026')).toBe(false)
  })

  test('a card changes every repo unless it picks some', () => {
    expect(reposFor(ws, card('a', {})).map(r => r.name)).toEqual(['ideajudge-services', 'ideajudge-ui'])
    expect(reposFor(ws, card('a', { repos: ['ideajudge-ui'] })).map(r => r.name)).toEqual(['ideajudge-ui'])
  })

  test('the card folder sits beside the workspace', () => {
    expect(worktreeFor(ws, card('k1', {}))).toBe(`${CARD_DIR}/k1`)
  })

  test('prompts name the repos and each repo base', () => {
    const p = cardPrompt(ws, card('k1', { repos: ['ideajudge-ui'] }), `${CARD_DIR}/k1`)
    expect(p).toContain('mirrors the workspace /development/ideajudge-2026')
    expect(p).toContain('The repos you may change: ideajudge-ui.')
    const m = mergePrompt(ws, card('k1', { branch: 'kanbot/k1', mergeRepos: ['ideajudge-ui'] }))
    expect(m).toContain('- ideajudge-ui: develop')
    expect(m).not.toContain('ideajudge-services')
    expect(m).toContain('Merge nothing.')
  })
})

type World = {
  writes: Map<string, unknown>
  spawns: { prompt: string; cwd?: string; description?: string }[]
  git: string[][]
  agents: { id: string; status: string; description: string }[]
}

/** Git as a workspace answers it: `commits` per repo, and which repos have merged. */
function world(on: On, entries: Record<string, unknown>, commits: Record<string, number>, merged: string[]): World {
  const w: World = { writes: new Map(), spawns: [], git: [], agents: [] }
  on('store.set', { key: /^card:/ }, async ($, e, next) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    w.writes.set(key, value)
    return next(e)
  })
  mock.store(on, entries)
  on('session.id', async () => ({ value: 'S1' }) as never)
  on('session.cwd', async () => ({ value: '/development' }) as never)
  on('command.register', async () => ({ value: null }) as never)
  on('ui.status', async () => ({ value: null }) as never)
  on('ui.toast', async () => ({ value: null }) as never)
  on('fs.exists', async () => ({ value: false }) as never)
  on('agent.list', async () => ({ value: w.agents.map(a => ({ ...a, type: 'general-purpose', spawnedBy: 'kanbot' })) }) as never)
  on('agent.spawn', async (_$, e) => {
    const s = e as unknown as { prompt: string; cwd?: string; description?: string }
    w.spawns.push(s)
    const agentId = `A${w.spawns.length}`
    w.agents.push({ id: agentId, status: 'running', description: s.description ?? '' })
    return { model: 'test', agentId } as never
  })
  on('process.run', async (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    w.git.push(argv)
    const repo = (argv[2] ?? '').split('/').pop() ?? ''
    const verb = argv[3]
    let exitCode = 0
    let stdout = ''
    if (verb === 'rev-parse') exitCode = 1
    if (verb === 'rev-list') stdout = String(commits[repo] ?? 0)
    if (verb === 'merge-base') exitCode = merged.includes(repo) ? 0 : 1
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.start', async () => ({ cwd: '/development' }) as never)
  return w
}
const card$ = (w: World, id: string) => w.writes.get(`card:${id}`) as Card
const start = async ($: any) => $.session.start({ cwd: '/development', surface: 'terminal', isInteractive: true })

describe('workspace dispatch', () => {
  test('a card gets a folder with one worktree per repo it may change', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(
      on,
      { 'project:pws': ws, 'card:w1': card('w1', {}), dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false } },
      {},
      [],
    )
    await start($)
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0]!.cwd).toBe(`${CARD_DIR}/w1`)
    expect(w.git).toContainEqual([
      'git', '-C', '/development/ideajudge-2026/ideajudge-services',
      'worktree', 'add', '-b', 'kanbot/w1', `${CARD_DIR}/w1/ideajudge-services`, 'main',
    ])
    expect(w.git).toContainEqual([
      'git', '-C', '/development/ideajudge-2026/ideajudge-ui',
      'worktree', 'add', '-b', 'kanbot/w1', `${CARD_DIR}/w1/ideajudge-ui`, 'develop',
    ])
    expect(card$(w, 'w1').touched).toEqual(['ideajudge-services', 'ideajudge-ui'])
  })

  test('a card that picked one repo gets only that worktree', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(
      on,
      { 'project:pws': ws, 'card:w2': card('w2', { repos: ['ideajudge-ui'] }), dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false } },
      {},
      [],
    )
    await start($)
    await clock.advance(3000)
    expect(w.git.filter(a => a[3] === 'worktree' && a[4] === 'add')).toHaveLength(1)
    expect(card$(w, 'w2').touched).toEqual(['ideajudge-ui'])
  })

  test('Done merges only the repos with commits, then cleans up every worktree', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(
      on,
      {
        'project:pws': ws,
        'card:w3': card('w3', {
          column: 'review',
          branch: 'kanbot/w3',
          worktree: `${CARD_DIR}/w3`,
          touched: ['ideajudge-services', 'ideajudge-ui'],
          mergeRequested: true,
        }),
        dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
      },
      { 'ideajudge-ui': 2, 'ideajudge-services': 0 },
      ['ideajudge-ui'],
    )
    await start($)
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0]!.cwd).toBe('/development/ideajudge-2026')
    expect(w.spawns[0]!.prompt).toContain('- ideajudge-ui: develop')
    expect(w.spawns[0]!.prompt).not.toContain('- ideajudge-services')
    await ($ as any).turn.complete({ turnId: 't', agentId: 'A1', answer: 'MERGED ideajudge-ui', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(card$(w, 'w3').column).toBe('done')
    expect(w.git).toContainEqual(['git', '-C', '/development/ideajudge-2026/ideajudge-ui', 'branch', '-d', 'kanbot/w3'])
    expect(w.git).toContainEqual(['git', '-C', '/development/ideajudge-2026/ideajudge-services', 'branch', '-D', 'kanbot/w3'])
    expect(w.git).toContainEqual([
      'git', '-C', '/development/ideajudge-2026/ideajudge-services', 'worktree', 'remove', '--force', `${CARD_DIR}/w3/ideajudge-services`,
    ])
  })

  test('a partial merge keeps the card in Review with the repos still to merge', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(
      on,
      {
        'project:pws': ws,
        'card:w4': card('w4', {
          column: 'review',
          branch: 'kanbot/w4',
          worktree: `${CARD_DIR}/w4`,
          touched: ['ideajudge-services', 'ideajudge-ui'],
          mergeRequested: true,
        }),
        dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
      },
      { 'ideajudge-ui': 1, 'ideajudge-services': 3 },
      ['ideajudge-services'],
    )
    await start($)
    await clock.advance(3000)
    await ($ as any).turn.complete({ turnId: 't', agentId: 'A1', answer: 'NOT MERGED ideajudge-ui: conflict', durationMs: 1, isAborted: false, reason: 'answer' })
    const c = card$(w, 'w4')
    expect(c.column).toBe('review')
    expect(c.mergeRepos).toEqual(['ideajudge-ui'])
    expect(c.touched).toEqual(['ideajudge-ui'])
    expect(c.problem).toContain('Not merged: ideajudge-ui')
    expect(c.problem).toContain('Merged: ideajudge-services')
  })

  test('a card with no commits anywhere is Done with nothing merged', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(
      on,
      {
        'project:pws': ws,
        'card:w5': card('w5', { column: 'review', branch: 'kanbot/w5', worktree: `${CARD_DIR}/w5`, touched: ['ideajudge-ui'], mergeRequested: true }),
        dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
      },
      {},
      [],
    )
    await start($)
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(0)
    expect(card$(w, 'w5').column).toBe('done')
  })
})
