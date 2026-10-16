import { describe, expect, test } from 'claude-code/testing'

import type { Card, Project } from '../types'
import { cardPrompt, mergePrompt, parseAdd, pickStarts, rankAt, userMove, worktreeFor } from '../hooks/model'

const repo = (id: string, maxParallel = 2): Project => ({
  id,
  name: id.toUpperCase(),
  type: 'repo',
  path: `/work/${id}`,
  baseBranch: 'main',
  maxParallel,
  testCommand: '',
  colour: 'cyan',
  createdAt: 0,
})
const chat: Project = { ...repo('notes'), type: 'chat', path: '/work/notes' }

let n = 0
const card = (projectId: string, over: Partial<Card> = {}): Card => {
  n += 1
  return {
    id: `c${n}`,
    projectId,
    title: `Card ${n}`,
    brief: '',
    acceptance: [],
    notes: [],
    mode: 'sequential',
    column: 'queued',
    rank: n,
    history: [],
    createdAt: n,
    updatedAt: n,
    ...over,
  }
}
const ids = (cards: Card[]) => cards.map(c => c.id)

describe('pickStarts', () => {
  test('a sequential card starts alone and blocks the cards under it', () => {
    const a = card('a')
    const b = card('a', { mode: 'parallel' })
    expect(ids(pickStarts([repo('a')], [a, b], 4))).toEqual([a.id])
  })

  test('a running sequential card holds its project queue', () => {
    const running = card('a', { column: 'running' })
    const next = card('a', { mode: 'parallel' })
    expect(pickStarts([repo('a')], [running, next], 4)).toEqual([])
  })

  test('parallel cards fill the project limit, top to bottom', () => {
    const cs = [card('a', { mode: 'parallel' }), card('a', { mode: 'parallel' }), card('a', { mode: 'parallel' })]
    expect(ids(pickStarts([repo('a', 2)], cs, 4))).toEqual([cs[0]!.id, cs[1]!.id])
  })

  test('a sequential card under parallel ones waits for them', () => {
    const p1 = card('a', { mode: 'parallel' })
    const s = card('a')
    expect(ids(pickStarts([repo('a', 3)], [p1, s], 4))).toEqual([p1.id])
  })

  test('projects run side by side and take turns under the global cap', () => {
    const a1 = card('a', { mode: 'parallel' })
    const a2 = card('a', { mode: 'parallel' })
    const b1 = card('b', { mode: 'parallel' })
    const b2 = card('b', { mode: 'parallel' })
    expect(ids(pickStarts([repo('a'), repo('b')], [a1, a2, b1, b2], 3))).toEqual([a1.id, b1.id, a2.id])
  })

  test('chat projects run one card at a time', () => {
    const c1 = card('notes', { mode: 'parallel' })
    const c2 = card('notes', { mode: 'parallel' })
    expect(ids(pickStarts([chat], [c1, c2], 4))).toEqual([c1.id])
  })

  test('nothing starts at the global cap', () => {
    const busy = [card('a', { column: 'running', mode: 'parallel' }), card('b', { column: 'running', mode: 'parallel' })]
    expect(pickStarts([repo('a'), repo('b')], [...busy, card('a', { mode: 'parallel' })], 2)).toEqual([])
  })
})

describe('userMove', () => {
  test('the moves a person can make', () => {
    expect(userMove(card('a', { column: 'backlog' }), 'queued').kind).toBe('queue')
    expect(userMove(card('a', { column: 'queued' }), 'backlog').kind).toBe('unqueue')
    expect(userMove(card('a', { column: 'review' }), 'done').kind).toBe('done')
    expect(userMove(card('a', { column: 'review' }), 'queued').kind).toBe('sendback')
    expect(userMove(card('a', { column: 'review' }), 'backlog').kind).toBe('discard')
    expect(userMove(card('a', { column: 'queued' }), 'queued').kind).toBe('reorder')
  })

  test('the moves only Kanbot makes are refused', () => {
    expect(userMove(card('a', { column: 'running' }), 'review').kind).toBe('deny')
    expect(userMove(card('a', { column: 'queued' }), 'running').kind).toBe('deny')
    expect(userMove(card('a', { column: 'backlog' }), 'done').kind).toBe('deny')
    expect(userMove(card('a', { column: 'done' }), 'queued').kind).toBe('deny')
    expect(userMove(card('a', { column: 'review', run: { phase: 'merge', startedAt: 0 } }), 'done').kind).toBe('deny')
  })
})

test('rankAt places a card between its neighbours', () => {
  const list = [card('a', { rank: 1 }), card('a', { rank: 3 })]
  expect(rankAt(list, 0)).toBe(0)
  expect(rankAt(list, 1)).toBe(2)
  expect(rankAt(list, 2)).toBe(4)
  expect(rankAt([], 0)).toBe(0)
})

test('parseAdd reads a project, a title and a brief', () => {
  const projects = [repo('ij')]
  expect(parseAdd('IJ: Fix login | the token expires', projects)).toEqual({ projectId: 'ij', title: 'Fix login', brief: 'the token expires' })
  expect(parseAdd('Fix login', projects)).toEqual({ title: 'Fix login', brief: '' })
  expect(parseAdd('Note: not a project', projects)).toEqual({ title: 'Note: not a project', brief: '' })
})

test('worktrees sit beside the repo, one per card', () => {
  expect(worktreeFor(repo('ij'), card('ij', { id: 'k1' }))).toBe('/work/.kanbot-worktrees/ij/k1')
})

test('prompts carry the brief, checklist, notes and the rules', () => {
  const c = card('ij', { id: 'k1', title: 'Fix login', brief: 'Token expires early', acceptance: ['tests pass'], notes: ['use refresh tokens'] })
  const p = cardPrompt(repo('ij'), c, '/wt/k1')
  expect(p).toContain('Token expires early')
  expect(p).toContain('- [ ] tests pass')
  expect(p).toContain('use refresh tokens')
  expect(p).toContain('branch kanbot/k1')
  expect(p).toContain('Do not switch branches')
  expect(cardPrompt(chat, c, '/work/notes')).toContain('not a git repository')
  const m = mergePrompt({ ...repo('ij'), testCommand: 'npm test' }, { ...c, branch: 'kanbot/k1' })
  expect(m).toContain('git merge --no-ff kanbot/k1')
  expect(m).toContain('npm test')
  expect(m).toContain('MERGED or NOT MERGED')
})
