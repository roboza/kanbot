import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Card, Project } from '../types'

const project: Project = {
  id: 'pij',
  name: 'IdeaJudge',
  type: 'repo',
  path: '/work/ij',
  baseBranch: 'main',
  maxParallel: 2,
  testCommand: 'npm test',
  colour: 'cyan',
  createdAt: 1,
}
const card = (id: string, over: Partial<Card>): Card => ({
  id,
  projectId: 'pij',
  title: `Card ${id}`,
  brief: `Brief for ${id}`,
  acceptance: ['tests pass'],
  notes: [],
  mode: 'sequential',
  column: 'queued',
  rank: 0,
  history: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

type World = {
  writes: Map<string, unknown>
  spawns: { prompt: string; cwd?: string; description?: string }[]
  git: string[][]
  agents: { id: string; status: string; description: string }[]
  toasts: string[]
}

/** The world beneath Kanbot: store, clock, session, agents, git. */
function world(on: On, entries: Record<string, unknown>, merged = true): World {
  const w: World = { writes: new Map(), spawns: [], git: [], agents: [], toasts: [] }
  on('store.set', { key: /^card:/ }, async ($, e, next) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    w.writes.set(key, value)
    return next(e)
  })
  mock.store(on, entries)
  on('session.id', async () => ({ value: 'S1' }) as never)
  on('session.cwd', async () => ({ value: '/work/ij' }) as never)
  on('command.register', async () => ({ value: null }) as never)
  on('ui.status', async () => ({ value: null }) as never)
  on('ui.toast', async (_$, e) => {
    w.toasts.push(JSON.stringify(e))
    return { value: null } as never
  })
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
    const verb = argv[3]
    // No branch exists yet; every other git call succeeds.
    const exitCode = verb === 'rev-parse' ? 1 : verb === 'merge-base' ? (merged ? 0 : 1) : 0
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.start', async () => ({ cwd: '/work/ij' }) as never)
  return w
}

const card$ = (w: World, id: string) => w.writes.get(`card:${id}`) as Card

describe('dispatcher', () => {
  test('starts a queued card in its own worktree, tracks it, and moves it to Review', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(on, {
      'project:pij': project,
      'card:q1': card('q1', {}),
      'card:q2': card('q2', { rank: 1 }),
      dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
    })
    await ($ as any).session.start({ cwd: '/work/ij', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)

    // One sequential card at a time: q1 starts, q2 waits.
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0]!.cwd).toBe('/work/.kanbot-worktrees/ij/q1')
    expect(w.spawns[0]!.prompt).toContain('Brief for q1')
    expect(w.spawns[0]!.prompt).toContain('branch kanbot/q1')
    expect(w.git).toContainEqual(['git', '-C', '/work/ij', 'worktree', 'add', '-b', 'kanbot/q1', '/work/.kanbot-worktrees/ij/q1', 'main'])
    expect(card$(w, 'q1').column).toBe('running')
    expect(card$(w, 'q1').run?.agentId).toBe('A1')

    // The agent works: its task list becomes the card's progress.
    await ($ as any).tool.call({
      tool: 'TodoWrite',
      tool_use_id: 'u1',
      agentId: 'A1',
      todos: [
        { content: 'a', status: 'completed', activeForm: 'a' },
        { content: 'b', status: 'in_progress', activeForm: 'b' },
      ],
    })
    await clock.advance(3000)
    expect(card$(w, 'q1').progress).toEqual({ done: 1, total: 2 })
    expect(card$(w, 'q1').activity?.lastTool).toBe('TodoWrite')

    // The agent finishes: the card goes to Review with its summary, and q2 starts.
    w.agents[0]!.status = 'completed'
    await ($ as any).turn.complete({
      turnId: 't1',
      agentId: 'A1',
      answer: 'Fixed it. Run npm test.',
      durationMs: 10,
      isAborted: false,
      reason: 'answer',
    })
    expect(card$(w, 'q1').column).toBe('review')
    expect(card$(w, 'q1').summary).toBe('Fixed it. Run npm test.')
    expect(w.toasts.join(' ')).toContain('ready for review')
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(2)
    expect(card$(w, 'q2').column).toBe('running')
  })

  test('Done merges the branch, then cleans up the worktree', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(on, {
      'project:pij': project,
      'card:m1': card('m1', {
        column: 'review',
        branch: 'kanbot/m1',
        worktree: '/work/.kanbot-worktrees/ij/m1',
        mergeRequested: true,
        summary: 'done',
      }),
      dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
    })
    await ($ as any).session.start({ cwd: '/work/ij', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0]!.cwd).toBe('/work/ij')
    expect(w.spawns[0]!.prompt).toContain('git merge --no-ff kanbot/m1')
    expect(w.spawns[0]!.prompt).toContain('npm test')
    expect(card$(w, 'm1').run?.phase).toBe('merge')

    await ($ as any).turn.complete({ turnId: 't', agentId: 'A1', answer: 'MERGED: clean', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(card$(w, 'm1').column).toBe('done')
    expect(card$(w, 'm1').branch).toBeUndefined()
    expect(w.git).toContainEqual(['git', '-C', '/work/ij', 'worktree', 'remove', '--force', '/work/.kanbot-worktrees/ij/m1'])
    expect(w.git).toContainEqual(['git', '-C', '/work/ij', 'branch', '-d', 'kanbot/m1'])
  })

  test('a merge that did not land returns the card to Review with the reason', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(
      on,
      {
        'project:pij': project,
        'card:m2': card('m2', { column: 'review', branch: 'kanbot/m2', worktree: '/wt/m2', mergeRequested: true }),
        dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
      },
      false,
    )
    await ($ as any).session.start({ cwd: '/work/ij', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    await ($ as any).turn.complete({ turnId: 't', agentId: 'A1', answer: 'NOT MERGED: conflict in app.ts', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(card$(w, 'm2').column).toBe('review')
    expect(card$(w, 'm2').problem).toContain('conflict in app.ts')
    expect(card$(w, 'm2').branch).toBe('kanbot/m2')
    expect(w.git.some(a => a.includes('remove'))).toBe(false)
  })

  test('a lost agent requeues its card, which starts again', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(on, {
      'project:pij': project,
      'card:l1': card('l1', { column: 'running', run: { phase: 'work', startedAt: now, agentId: 'GONE' } }),
      'card:q9': card('q9', { rank: 5 }),
      dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: false },
    })
    await ($ as any).session.start({ cwd: '/work/ij', surface: 'terminal', isInteractive: true })
    // Two ticks without the agent: still waiting for it.
    await clock.advance(3000)
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(0)
    // The third: back to the top of Queued, and started again ahead of q9.
    await clock.advance(3000)
    const l1 = card$(w, 'l1')
    expect(l1.history.map(h => h.text)).toContain('Run stopped; requeued')
    expect(w.spawns).toHaveLength(1)
    expect(w.spawns[0]!.description).toContain('Kanbot l1')
    expect(l1.column).toBe('running')
  })

  test('a session that is not the dispatcher starts nothing', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(on, {
      'project:pij': project,
      'card:q1': card('q1', {}),
      dispatcher: { sessionId: 'OTHER', heartbeatAt: now, isPaused: false },
    })
    await ($ as any).session.start({ cwd: '/work/ij', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(0)
  })

  test('a paused dispatcher starts nothing new', async ($, on) => {
    const now = Date.now()
    const clock = mock.clock(on, { now })
    const w = world(on, {
      'project:pij': project,
      'card:q1': card('q1', {}),
      dispatcher: { sessionId: 'S1', heartbeatAt: now, isPaused: true },
    })
    await ($ as any).session.start({ cwd: '/work/ij', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    expect(w.spawns).toHaveLength(0)
  })
})
