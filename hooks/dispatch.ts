// The dispatcher: one session (the one that ran `/kanbot work`) starts queued
// cards as background agents, follows their tool calls, and runs merges.
import type { EngineInterface } from 'claude-code'

import type { ActivityEntry, Card, Project } from '../types'
import type { Board } from './data'
import {
  ensureWorkspace,
  ensureWorktree,
  getCard,
  isMerged,
  isRepoMerged,
  removeRepoWorktree,
  reposWithWork,
  loadBoard,
  logActivity,
  patchCard,
  removeWorktree,
  withHistory,
} from './data'
import { cardPrompt, isActive, mergePrompt, pickStarts, topRank } from './model'

type E = EngineInterface

export const HEARTBEAT_STALE_MS = 30_000
const MISSING_TICKS = 3

/** What the dispatcher has seen of a card's agent since the last flush. */
type Pending = {
  toolCalls: number
  lastTool: string
  lastAt: number
  tokens: number
  todo?: { done: number; total: number }
  tasksMade: number
  tasksDone: Set<string>
  tasksGone: Set<string>
  waiting?: string
  /** Something changed since the last flush. */
  dirty: boolean
}

export const me = { sessionId: '', isDispatcher: false }
const agentCard = new Map<string, string>()
const pending = new Map<string, Pending>()
const feed: ActivityEntry[] = []
let busy = false

function pend(cardId: string): Pending {
  let p = pending.get(cardId)
  if (p === undefined) {
    p = { toolCalls: 0, lastTool: '', lastAt: 0, tokens: 0, tasksMade: 0, tasksDone: new Set(), tasksGone: new Set(), dirty: false }
    pending.set(cardId, p)
  }
  return p
}

function note(card: Pick<Card, 'id' | 'projectId'>, text: string): void {
  feed.push({ at: Date.now(), cardId: card.id, projectId: card.projectId, text })
}

export function cardForAgent(agentId: string | undefined): string | undefined {
  return agentId === undefined ? undefined : agentCard.get(agentId)
}

/** Sums a usage record's token counts, whatever fields it carries. */
export function tokensOf(usage: unknown): number {
  if (typeof usage !== 'object' || usage === null) return 0
  let n = 0
  for (const [k, v] of Object.entries(usage)) if (k.endsWith('tokens') && typeof v === 'number') n += v
  return n
}

function describeTool(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const path = pick('file_path') || pick('path') || pick('notebook_path')
  if (path !== '') return `${tool} ${path.split('/').slice(-2).join('/')}`
  const cmd = pick('command')
  if (cmd !== '') return `${tool}: ${cmd.slice(0, 70)}`
  const sub = pick('subject') || pick('description') || pick('pattern') || pick('query')
  return sub === '' ? tool : `${tool}: ${sub.slice(0, 70)}`
}

/** Called from the `tool.call` hook for every tool call of a card's agent. */
export function sawToolCall(cardId: string, tool: string, input: Record<string, unknown>): void {
  const p = pend(cardId)
  p.dirty = true
  p.toolCalls += 1
  p.lastTool = tool
  p.lastAt = Date.now()
  p.waiting = undefined
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos as { status?: unknown }[]
    p.todo = { done: todos.filter(t => t.status === 'completed').length, total: todos.length }
  }
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    if (input.status === 'completed') p.tasksDone.add(input.taskId)
    if (input.status === 'deleted') p.tasksGone.add(input.taskId)
  }
  feed.push({ at: p.lastAt, cardId, projectId: '', text: describeTool(tool, input) })
}

export function sawTaskMade(cardId: string): void {
  const p = pend(cardId)
  p.tasksMade += 1
  p.dirty = true
}

export function sawDenied(cardId: string, tool: string, reason: string): void {
  const p = pend(cardId)
  p.dirty = true
  p.waiting = `${tool} was refused: ${reason.slice(0, 200)}. Allow it in the Kanbot session's permissions, or send the card back with guidance.`
}

/** Writes what was seen into the cards. */
async function flush($: E, board: Board): Promise<void> {
  for (const [cardId, p] of pending) {
    const card = board.cards.find(c => c.id === cardId)
    if (card === undefined) {
      pending.delete(cardId)
      continue
    }
    if (!p.dirty) continue
    await patchCard($, cardId, c => {
      const a = c.activity ?? { lastTool: '', lastAt: 0, toolCalls: 0, tokens: 0 }
      const total = p.todo?.total ?? Math.max(0, p.tasksMade - p.tasksGone.size)
      const done = p.todo?.done ?? p.tasksDone.size
      return {
        ...c,
        activity: {
          lastTool: p.lastTool || a.lastTool,
          lastAt: Math.max(p.lastAt, a.lastAt),
          toolCalls: a.toolCalls + p.toolCalls,
          tokens: a.tokens + p.tokens,
        },
        progress: total > 0 ? { done: Math.min(done, total), total } : c.progress,
        waiting: p.waiting ?? (p.toolCalls > 0 ? undefined : c.waiting),
      }
    })
    // Keep task counts (they accumulate over the run); clear the deltas.
    p.toolCalls = 0
    p.tokens = 0
    p.waiting = undefined
    p.dirty = false
  }
  const entries = feed.splice(0, feed.length).map(f => {
    if (f.projectId !== '') return f
    const card = board.cards.find(c => c.id === f.cardId)
    return { ...f, projectId: card?.projectId ?? '' }
  })
  await logActivity($, entries)
}

/** Spawns a background agent and answers its id, finding it by description if the answer carries none. */
async function spawnAgent($: E, args: { prompt: string; description: string; cwd: string }): Promise<{ agentId: string } | { deny: string }> {
  const before = new Set((await $.agent.list()).map(a => a.id))
  const spawned = await $.agent.spawn({ ...args, subagentType: 'general-purpose' })
  if (spawned.deny !== undefined) return { deny: spawned.deny }
  if (spawned.agentId !== undefined) return { agentId: spawned.agentId }
  const found = (await $.agent.list()).find(a => !before.has(a.id) && a.description === args.description)
  return found === undefined ? { deny: 'the agent did not start' } : { agentId: found.id }
}

async function startCard($: E, board: Board, project: Project, card: Card): Promise<void> {
  // Claim it first, so no later tick starts it twice.
  const claimed = await patchCard($, card.id, c =>
    c.column === 'queued'
      ? withHistory(
          { ...c, column: 'running', run: { phase: 'work', startedAt: Date.now() }, waiting: undefined, problem: undefined },
          'Started',
        )
      : undefined,
  )
  if (claimed === undefined) return
  let cwd = project.path
  let extra: Partial<Card> = {}
  if (project.type === 'repo') {
    const wt = await ensureWorktree($, project, claimed)
    if ('problem' in wt) {
      await patchCard($, card.id, c =>
        withHistory({ ...c, column: 'backlog', run: undefined, problem: wt.problem }, 'Could not start'),
      )
      note(card, `could not start: ${wt.problem}`)
      return
    }
    cwd = wt.path
    extra = { branch: wt.branch, worktree: wt.path }
  }
  if (project.type === 'workspace') {
    const ws = await ensureWorkspace($, project, claimed)
    if ('problem' in ws) {
      await patchCard($, card.id, c =>
        withHistory({ ...c, column: 'backlog', run: undefined, problem: ws.problem }, 'Could not start'),
      )
      note(card, `could not start: ${ws.problem}`)
      return
    }
    cwd = ws.path
    extra = { branch: ws.branch, worktree: ws.path, touched: ws.touched }
  }
  const spawned = await spawnAgent($, {
    prompt: cardPrompt(project, { ...claimed, ...extra }, cwd),
    description: `Kanbot ${card.id}: ${card.title}`.slice(0, 60),
    cwd,
  })
  if ('deny' in spawned) {
    const why = spawned.deny
    await patchCard($, card.id, c =>
      withHistory({ ...c, ...extra, column: 'queued', rank: topRank(board.cards, 'queued'), run: undefined, problem: `Could not start: ${why}` }, 'Could not start'),
    )
    note(card, `could not start: ${why}`)
    return
  }
  agentCard.set(spawned.agentId, card.id)
  await patchCard($, card.id, c => ({
    ...c,
    ...extra,
    run: { phase: 'work', startedAt: c.run?.startedAt ?? Date.now(), agentId: spawned.agentId },
  }))
  note(card, `started in ${cwd}`)
}

async function startMerge($: E, project: Project, card: Card): Promise<void> {
  const claimed = await patchCard($, card.id, c =>
    c.mergeRequested === true && c.run === undefined
      ? withHistory({ ...c, mergeRequested: false, run: { phase: 'merge', startedAt: Date.now() } }, 'Merging')
      : undefined,
  )
  if (claimed === undefined) return
  let toMerge = claimed
  if (project.type === 'workspace') {
    const names = claimed.mergeRepos !== undefined && claimed.mergeRepos.length > 0 ? claimed.mergeRepos : await reposWithWork($, project, claimed)
    if (names.length === 0) {
      // Nothing was committed anywhere: nothing to merge, only worktrees to remove.
      for (const name of claimed.touched ?? []) await removeRepoWorktree($, project, claimed, name, 'force')
      await patchCard($, card.id, c =>
        withHistory(
          { ...c, column: 'done', run: undefined, branch: undefined, worktree: undefined, touched: undefined, mergeRepos: undefined },
          'Done: no repo had commits to merge',
        ),
      )
      note(card, 'done; nothing to merge')
      return
    }
    const saved = await patchCard($, card.id, c => ({ ...c, mergeRepos: names }))
    toMerge = saved ?? { ...claimed, mergeRepos: names }
  }
  const spawned = await spawnAgent($, {
    prompt: mergePrompt(project, toMerge),
    description: `Kanbot merge ${card.id}`.slice(0, 60),
    cwd: project.path,
  })
  if ('deny' in spawned) {
    const why = spawned.deny
    await patchCard($, card.id, c => withHistory({ ...c, run: undefined, problem: `Merge did not start: ${why}` }, 'Merge failed'))
    return
  }
  agentCard.set(spawned.agentId, card.id)
  await patchCard($, card.id, c => ({
    ...c,
    run: { phase: 'merge', startedAt: c.run?.startedAt ?? Date.now(), agentId: spawned.agentId },
  }))
  note(card, 'merging')
}

/** One dispatcher tick: heartbeat, flush, check agents, start merges and cards. */
export async function dispatch($: E, board: Board): Promise<void> {
  if (busy) return
  busy = true
  try {
    const d = board.dispatcher
    if (d === undefined || d.sessionId !== me.sessionId) {
      me.isDispatcher = false
      return
    }
    await $.store.set('dispatcher', { ...d, heartbeatAt: Date.now() })
    await flush($, board)
    const fresh = await loadBoard($)

    // Agents that are waiting, gone, or ended without a word.
    const agents = await $.agent.list()
    for (const card of fresh.cards.filter(c => isActive(c) && c.run?.agentId !== undefined)) {
      const agentId = card.run?.agentId ?? ''
      agentCard.set(agentId, card.id)
      const info = agents.find(a => a.id === agentId)
      const gone = info === undefined || info.status === 'failed' || info.status === 'killed'
      if (gone) {
        const missing = (card.run?.missing ?? 0) + 1
        if (missing < MISSING_TICKS) {
          await patchCard($, card.id, c => (c.run === undefined ? undefined : { ...c, run: { ...c.run, missing } }))
          continue
        }
        await lost($, fresh, card, info === undefined ? 'its agent is gone (was the Kanbot session restarted?)' : `its agent ${info.status}`)
        continue
      }
      if (info.status === 'waiting' && (card.waiting ?? '') === '') {
        await patchCard($, card.id, c => ({ ...c, waiting: 'Claude is waiting in the Kanbot session: open it to answer.' }))
        $.ui.toast(`Kanbot ${card.id} is waiting on you`)
      }
    }

    if (d.isPaused) return

    for (const card of fresh.cards.filter(c => c.column === 'review' && c.mergeRequested === true && c.run === undefined)) {
      const project = fresh.projects.find(p => p.id === card.projectId)
      const merging = fresh.cards.some(c => c.projectId === card.projectId && c.run?.phase === 'merge')
      if (project !== undefined && !merging) await startMerge($, project, card)
    }

    const after = await loadBoard($)
    for (const card of pickStarts(after.projects, after.cards, after.settings.globalCap)) {
      const project = after.projects.find(p => p.id === card.projectId)
      if (project !== undefined) await startCard($, after, project, card)
    }
  } finally {
    busy = false
  }
}

async function lost($: E, board: Board, card: Card, why: string): Promise<void> {
  if (card.run?.phase === 'merge') {
    await patchCard($, card.id, c => withHistory({ ...c, run: undefined, problem: `The merge stopped: ${why}. Mark it Done again to retry.` }, 'Merge stopped'))
  } else {
    await patchCard($, card.id, c =>
      withHistory(
        { ...c, column: 'queued', rank: topRank(board.cards, 'queued'), run: undefined, problem: `The run stopped: ${why}. It will start again.` },
        'Run stopped; requeued',
      ),
    )
  }
  note(card, `stopped: ${why}`)
}

/** A card's agent finished a turn: the run ends. */
export async function finished(
  $: E,
  agentId: string,
  end: { answer: string; reason: string; usage?: unknown },
): Promise<void> {
  const cardId = agentCard.get(agentId)
  if (cardId === undefined) return
  agentCard.delete(agentId)
  const card = await getCard($, cardId)
  if (card === undefined || card.run?.agentId !== agentId) return
  const board = await loadBoard($)
  const project = board.projects.find(p => p.id === card.projectId)
  const p = pend(cardId)
  p.tokens += tokensOf(end.usage)
  p.dirty = true
  await flush($, board)

  if (card.run.phase === 'merge' && project !== undefined && project.type === 'workspace') {
    await finishWorkspaceMerge($, board, project, card, end.answer)
    pending.delete(cardId)
    return
  }

  if (card.run.phase === 'merge') {
    if (project !== undefined && (await isMerged($, project, card))) {
      await removeWorktree($, project, card, 'merged')
      await patchCard($, cardId, c =>
        withHistory(
          { ...c, column: 'done', rank: topRank(board.cards, 'done'), run: undefined, branch: undefined, worktree: undefined, waiting: undefined, problem: undefined },
          'Merged; Done',
        ),
      )
      note(card, 'merged and done')
      $.ui.toast(`Kanbot ${card.id} merged: ${card.title}`)
    } else {
      await patchCard($, cardId, c =>
        withHistory({ ...c, run: undefined, problem: `Not merged. ${end.answer.trim().slice(-600)}` }, 'Merge did not complete'),
      )
      note(card, 'merge did not complete')
      $.ui.toast(`Kanbot ${card.id}: the merge did not complete`)
    }
    pending.delete(cardId)
    return
  }

  if (end.reason !== 'answer') {
    await patchCard($, cardId, c =>
      withHistory(
        { ...c, column: 'queued', rank: topRank(board.cards, 'queued'), run: undefined, problem: `The run ended early (${end.reason}). It will start again.` },
        `Run ended: ${end.reason}`,
      ),
    )
    note(card, `run ended: ${end.reason}`)
    pending.delete(cardId)
    return
  }
  await patchCard($, cardId, c =>
    withHistory(
      { ...c, column: 'review', rank: topRank(board.cards, 'review'), run: undefined, summary: end.answer.trim(), waiting: undefined, problem: undefined },
      'Finished; ready for review',
    ),
  )
  note(card, 'ready for review')
  $.ui.toast(`Kanbot ${card.id} is ready for review: ${card.title}`)
  pending.delete(cardId)
}

/** Checks each repo the merge was to land in, cleans up what landed, keeps the rest in Review. */
async function finishWorkspaceMerge($: E, board: Board, project: Project, card: Card, answer: string): Promise<void> {
  const wanted = card.mergeRepos ?? []
  const merged: string[] = []
  for (const name of wanted) {
    if (await isRepoMerged($, project, card, name)) {
      await removeRepoWorktree($, project, card, name, 'merged')
      merged.push(name)
    }
  }
  const left = wanted.filter(n => !merged.includes(n))
  if (left.length === 0) {
    // Repos the card never changed still hold a worktree: remove those too.
    for (const name of (card.touched ?? []).filter(n => !merged.includes(n))) await removeRepoWorktree($, project, card, name, 'force')
    await patchCard($, card.id, c =>
      withHistory(
        {
          ...c,
          column: 'done',
          rank: topRank(board.cards, 'done'),
          run: undefined,
          branch: undefined,
          worktree: undefined,
          touched: undefined,
          mergeRepos: undefined,
          waiting: undefined,
          problem: undefined,
        },
        `Merged ${merged.join(', ')}; Done`,
      ),
    )
    note(card, `merged ${merged.join(', ')}`)
    $.ui.toast(`Kanbot ${card.id} merged: ${card.title}`)
    return
  }
  await patchCard($, card.id, c =>
    withHistory(
      {
        ...c,
        run: undefined,
        mergeRepos: left,
        touched: (c.touched ?? []).filter(n => !merged.includes(n)),
        problem: `Not merged: ${left.join(', ')}.${merged.length > 0 ? ` Merged: ${merged.join(', ')}.` : ''} Mark it Done again to retry. ${answer.trim().slice(-500)}`,
      },
      merged.length > 0 ? `Merged ${merged.join(', ')}; ${left.join(', ')} left` : 'Merge did not complete',
    ),
  )
  note(card, `merge incomplete: ${left.join(', ')} left`)
  $.ui.toast(`Kanbot ${card.id}: ${left.join(', ')} not merged`)
}

export function dispatcherState(board: Board, now: number): 'mine' | 'other' | 'stale' | 'none' {
  const d = board.dispatcher
  if (d === undefined) return 'none'
  if (d.sessionId === me.sessionId) return 'mine'
  return now - d.heartbeatAt > HEARTBEAT_STALE_MS ? 'stale' : 'other'
}
