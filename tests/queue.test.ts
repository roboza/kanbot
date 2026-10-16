import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checkPlanned, leadingProject, queuePrompt } from '../hooks/model'
import type { Card, Project } from '../types'

const repo: Project = {
  id: 'pij',
  name: 'IdeaJudge',
  type: 'repo',
  path: '/work/ideajudge',
  baseBranch: 'main',
  maxParallel: 2,
  testCommand: '',
  colour: 'cyan',
  createdAt: 1,
}
const ws: Project = {
  id: 'pws',
  name: 'IdeaJudge 2026',
  type: 'workspace',
  path: '/development/ideajudge-2026',
  baseBranch: '',
  maxParallel: 2,
  testCommand: '',
  colour: 'magenta',
  createdAt: 2,
  repos: [
    { name: 'ideajudge-ui', baseBranch: 'develop' },
    { name: 'ideajudge-services', baseBranch: 'main' },
  ],
}

describe('plan helpers', () => {
  test('a project named first is read off the front, longest name first', () => {
    expect(leadingProject('IdeaJudge 2026 keep it small', [repo, ws])).toEqual({ project: ws, rest: 'keep it small' })
    expect(leadingProject('ideajudge: only the API', [repo, ws])).toEqual({ project: repo, rest: 'only the API' })
    expect(leadingProject('ideajudgement', [repo, ws])).toEqual({ rest: 'ideajudgement' })
    expect(leadingProject('', [repo])).toEqual({ rest: '' })
  })

  test('planned cards are checked and tidied', () => {
    const ok = checkPlanned(
      [
        { title: ' Add export ', brief: 'Export CSV.', acceptance: ['header row', '', 3], mode: 'parallel', repos: ['ideajudge-ui'] },
        { title: 'Docs', brief: 'Write docs.', repos: ['ideajudge-ui', 'ideajudge-services'] },
      ],
      ws,
    )
    expect(ok).toEqual({
      cards: [
        { title: 'Add export', brief: 'Export CSV.', acceptance: ['header row'], mode: 'parallel', repos: ['ideajudge-ui'] },
        { title: 'Docs', brief: 'Write docs.', acceptance: [], mode: 'sequential' },
      ],
    })
    expect(checkPlanned([], ws)).toEqual({ error: '`cards` must be a non-empty list.' })
    expect(checkPlanned([{ title: 'x', brief: '' }], repo)).toMatchObject({ error: expect.stringContaining('has no brief') })
    expect(checkPlanned([{ title: 'x', brief: 'y', repos: ['nope'] }], ws)).toMatchObject({ error: expect.stringContaining('names repos nope') })
    // A repo project ignores repos.
    expect(checkPlanned([{ title: 'x', brief: 'y', repos: ['nope'] }], repo)).toEqual({ cards: [{ title: 'x', brief: 'y', acceptance: [], mode: 'sequential' }] })
  })

  test('the queue prompt names the project, its repos and the guidance', () => {
    const p = queuePrompt(ws, 'keep it small')
    expect(p).toContain('"IdeaJudge 2026"')
    expect(p).toContain('mcp__kanbot__queue_cards')
    expect(p).toContain('ideajudge-ui, ideajudge-services')
    expect(p).toContain('Extra guidance: keep it small')
    expect(queuePrompt(repo, '')).not.toContain('repos:')
  })
})

type World = { writes: Map<string, Card>; prompts: string[]; toasts: string[] }

function world(on: On, entries: Record<string, unknown>): World {
  const w: World = { writes: new Map(), prompts: [], toasts: [] }
  on('store.set', { key: /^card:/ }, async ($, e, next) => {
    const { key, value } = e as unknown as { key: string; value: Card }
    w.writes.set(key, value)
    return next(e)
  })
  mock.store(on, entries)
  on('session.cwd', async () => ({ value: '/development/ideajudge-2026/ideajudge-ui' }) as never)
  on('ui.toast', async (_$, e) => {
    w.toasts.push(JSON.stringify(e))
    return { value: null } as never
  })
  on('ui.log', async (_$, e) => {
    w.toasts.push(`log: ${JSON.stringify(e)}`)
    return { value: null } as never
  })
  on('prompt.submit', async (_$, e) => {
    const text = (e as unknown as { text: string }).text
    w.prompts.push(text)
    return { text } as never
  })
  return w
}

const TOOL = 'mcp__kanbot__queue_cards'

describe('queue_cards tool', () => {
  test('adds the cards to Backlog in order, for the project of the session folder', async ($, on) => {
    const w = world(on, { 'project:pij': repo, 'project:pws': ws })
    const r = await ($ as any).tool.call({
      tool: TOOL,
      tool_use_id: 'u1',
      cards: [
        { title: 'API endpoint', brief: 'Add GET /usage.', acceptance: ['returns JSON'], repos: ['ideajudge-services'] },
        { title: 'UI button', brief: 'Add an export button.', mode: 'parallel', repos: ['ideajudge-ui'] },
      ],
    })
    expect(String(r.result)).toContain("Added 2 cards to IdeaJudge 2026's Backlog")
    const cards = [...w.writes.values()].sort((a, b) => a.rank - b.rank)
    expect(cards.map(c => [c.title, c.column, c.projectId, c.mode])).toEqual([
      ['API endpoint', 'backlog', 'pws', 'sequential'],
      ['UI button', 'backlog', 'pws', 'parallel'],
    ])
    expect(cards[0]!.acceptance).toEqual(['returns JSON'])
    expect(cards[0]!.repos).toEqual(['ideajudge-services'])
    expect(cards[0]!.history[0]!.text).toBe('Created from a plan')
    expect(cards[0]!.rank).toBeLessThan(cards[1]!.rank)
    expect(w.toasts.join(' ')).toContain('2 cards added')
  })

  test('a named project wins; an unknown one is refused with the list', async ($, on) => {
    const w = world(on, { 'project:pij': repo, 'project:pws': ws })
    await ($ as any).tool.call({ tool: TOOL, tool_use_id: 'u1', project: 'ideajudge', cards: [{ title: 'Fix', brief: 'Fix it.' }] })
    expect([...w.writes.values()].map(c => c.projectId)).toEqual(['pij'])
    const r = await ($ as any).tool.call({ tool: TOOL, tool_use_id: 'u2', project: 'Nope', cards: [{ title: 'Fix', brief: 'Fix it.' }] })
    expect(String(r.deny)).toContain('No Kanbot project is called "Nope". Projects: IdeaJudge, IdeaJudge 2026.')
  })

  test('bad cards add nothing', async ($, on) => {
    const w = world(on, { 'project:pws': ws })
    const r = await ($ as any).tool.call({ tool: TOOL, tool_use_id: 'u1', cards: [{ title: 'Ok', brief: 'Fine.' }, { title: 'Bad', brief: 'x', repos: ['other'] }] })
    expect(String(r.deny)).toContain('names repos other')
    expect(w.writes.size).toBe(0)
  })
})

describe('/kanbot queue', () => {
  test('asks Claude to turn the plan into cards for the named project', async ($, on) => {
    const clock = mock.clock(on, { now: Date.now() })
    const w = world(on, { 'project:pij': repo, 'project:pws': ws })
    const r = await ($ as any).command.run({ command: 'kanbot', args: 'queue IdeaJudge keep it to three cards' })
    expect(w.prompts).toHaveLength(0)
    await clock.advance(1)
    expect(String(r.text)).toContain('cards for IdeaJudge')
    expect(String(r.text)).toContain('Backlog')
    expect(w.toasts.filter(t => t.startsWith('log:'))).toEqual([])
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('"IdeaJudge" (repo')
    expect(w.prompts[0]).toContain('Extra guidance: keep it to three cards')
  })

  test('with no project named, uses the one the session folder is in', async ($, on) => {
    const clock = mock.clock(on, { now: Date.now() })
    const w = world(on, { 'project:pij': repo, 'project:pws': ws })
    await ($ as any).command.run({ command: 'kanbot', args: 'queue' })
    await clock.advance(1)
    expect(w.prompts[0]).toContain('"IdeaJudge 2026" (workspace')
    expect(w.prompts[0]).not.toContain('Extra guidance')
  })

  test('with no projects, says how to add one', async ($, on) => {
    const w = world(on, {})
    const r = await ($ as any).command.run({ command: 'kanbot', args: 'queue' })
    expect(String(r.text)).toContain('/kanbot projects')
    expect(w.prompts).toHaveLength(0)
  })
})
