// Pure logic: no `$`, so every rule here is tested directly.
import type { Card, Column, Project, ProjectDraft, WorkspaceRepo } from '../types'

export const COLUMNS: readonly Column[] = ['backlog', 'queued', 'running', 'review', 'done']

export const COLUMN_NAMES: Record<Column, string> = {
  backlog: 'Backlog',
  queued: 'Queued',
  running: 'Running',
  review: 'Review',
  done: 'Done',
}

export const PROJECT_COLOURS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red'] as const

export const DEFAULT_CAP = 4

export const EMPTY_DRAFT: ProjectDraft = {
  name: '',
  type: 'repo',
  path: '',
  baseBranch: 'main',
  maxParallel: '2',
  testCommand: '',
}
export const STALL_MS = 10 * 60 * 1000

export function newId(now: number, random: number): string {
  return now.toString(36).slice(-5) + Math.floor(random * 1296).toString(36).padStart(2, '0')
}

export function byRank(a: Card, b: Card): number {
  return a.rank - b.rank || a.createdAt - b.createdAt
}

export function inColumn(cards: readonly Card[], column: Column, projectId?: string): Card[] {
  return cards
    .filter(c => c.column === column && (projectId === undefined || c.projectId === projectId))
    .sort(byRank)
}

/** A rank that puts a card at `index` among `others` (already sorted, the moved card left out). */
export function rankAt(others: readonly Card[], index: number): number {
  const i = Math.max(0, Math.min(index, others.length))
  const before = others[i - 1]
  const after = others[i]
  if (before === undefined && after === undefined) return 0
  if (before === undefined) return (after?.rank ?? 0) - 1
  if (after === undefined) return before.rank + 1
  return (before.rank + after.rank) / 2
}

export function topRank(cards: readonly Card[], column: Column): number {
  const list = inColumn(cards, column)
  return list.length === 0 ? 0 : (list[0]?.rank ?? 0) - 1
}

export function bottomRank(cards: readonly Card[], column: Column): number {
  const list = inColumn(cards, column)
  return list.length === 0 ? 0 : (list[list.length - 1]?.rank ?? 0) + 1
}

export function limitFor(project: Project): number {
  return project.type === 'chat' ? 1 : Math.max(1, Math.floor(project.maxParallel))
}

/** A card that occupies a run slot: working, or merging after Done. */
export function isActive(card: Card): boolean {
  return card.column === 'running' || (card.column === 'review' && card.run?.phase === 'merge')
}

/**
 * Which queued cards to start now. Each project's queue drains top to bottom:
 * a sequential card waits until nothing of its project runs and blocks the
 * cards under it; a parallel card starts while its project and the global cap
 * have room, and does not block. Projects take turns, so one long queue
 * cannot starve the others.
 */
export function pickStarts(projects: readonly Project[], cards: readonly Card[], globalCap: number): Card[] {
  let running = cards.filter(isActive).length
  const picked: Card[] = []
  const queues = projects.map(p => ({
    project: p,
    queue: inColumn(cards, 'queued', p.id),
    running: cards.filter(c => c.projectId === p.id && isActive(c)).length,
    // A running sequential card holds its project's queue until it ends.
    blocked: cards.some(c => c.projectId === p.id && c.column === 'running' && c.mode === 'sequential'),
  }))
  let progress = true
  while (progress && running < globalCap) {
    progress = false
    for (const q of queues) {
      if (running >= globalCap) break
      if (q.blocked) continue
      const next = q.queue[0]
      if (next === undefined) continue
      if (next.mode === 'sequential' || q.project.type === 'chat') {
        if (q.running > 0) {
          q.blocked = true
          continue
        }
        q.queue.shift()
        picked.push(next)
        q.running += 1
        running += 1
        q.blocked = true
        progress = true
        continue
      }
      if (q.running >= limitFor(q.project)) {
        q.blocked = true
        continue
      }
      q.queue.shift()
      picked.push(next)
      q.running += 1
      running += 1
      progress = true
    }
  }
  return picked
}

export type MoveAction =
  | { kind: 'reorder' }
  | { kind: 'queue' }
  | { kind: 'unqueue' }
  | { kind: 'done' }
  | { kind: 'sendback' }
  | { kind: 'discard' }
  | { kind: 'deny'; reason: string }

/** What a person moving a card from one column to another means. */
export function userMove(card: Card, to: Column): MoveAction {
  const from = card.column
  if (from === to) {
    if (from === 'running') return { kind: 'deny', reason: 'Running cards keep the order they started in.' }
    return { kind: 'reorder' }
  }
  if (from === 'running') return { kind: 'deny', reason: 'A running card moves to Review by itself when Claude finishes.' }
  if (from === 'done') return { kind: 'deny', reason: 'Done cards stay done. Add a new card for follow-up work.' }
  if (card.run?.phase === 'merge') return { kind: 'deny', reason: 'This card is merging; wait for it to finish.' }
  if (from === 'backlog' && to === 'queued') return { kind: 'queue' }
  if (from === 'queued' && to === 'backlog') return { kind: 'unqueue' }
  if (from === 'review' && to === 'done') return { kind: 'done' }
  if (from === 'review' && to === 'queued') return { kind: 'sendback' }
  if (from === 'review' && to === 'backlog') return { kind: 'discard' }
  if (to === 'running') return { kind: 'deny', reason: 'Queue the card; Kanbot starts it when there is room.' }
  if (to === 'review') return { kind: 'deny', reason: 'Cards reach Review when Claude finishes them.' }
  if (to === 'done') return { kind: 'deny', reason: 'Only a card in Review can be marked Done.' }
  return { kind: 'deny', reason: `A card cannot move from ${COLUMN_NAMES[from]} to ${COLUMN_NAMES[to]}.` }
}

export function branchFor(card: Card): string {
  return `kanbot/${card.id}`
}

/** A path in one spelling: forward slashes, no trailing slash, a lower-case drive letter. */
export function normPath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(p) ? p[0]!.toLowerCase() + p.slice(1) : p
}

/** Whether `inner` is `outer` or inside it; a path with no drive matches any drive. */
export function isWithin(inner: string, outer: string): boolean {
  const strip = (p: string) => normPath(p).replace(/^[a-z]:/, '').toLowerCase()
  const i = strip(inner)
  const o = strip(outer)
  return i === o || i.startsWith(o + '/')
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`
}

/** The workspace repos a card may change: its own pick, or every repo. */
export function reposFor(project: Project, card: Card): WorkspaceRepo[] {
  const all = project.repos ?? []
  if (card.repos === undefined || card.repos.length === 0) return all
  const picked = all.filter(r => card.repos?.includes(r.name))
  return picked.length === 0 ? all : picked
}

export function worktreeFor(project: Project, card: Card): string {
  const path = project.path.replace(/[\\/]+$/, '')
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = cut <= 0 ? path : path.slice(0, cut)
  const name = cut < 0 ? path : path.slice(cut + 1)
  return `${parent}/.kanbot-worktrees/${name}/${card.id}`
}

export function cardPrompt(project: Project, card: Card, cwd: string): string {
  const lines: string[] = []
  lines.push(`You are working on a Kanbot card for the project "${project.name}".`)
  lines.push('')
  lines.push(`Card ${card.id}: ${card.title}`)
  lines.push('')
  lines.push('## Brief')
  lines.push(card.brief.trim() === '' ? card.title : card.brief.trim())
  if (card.acceptance.length > 0) {
    lines.push('')
    lines.push('## Acceptance checklist (all must hold before you finish)')
    for (const item of card.acceptance) lines.push(`- [ ] ${item}`)
  }
  if (card.notes.length > 0) {
    lines.push('')
    lines.push('## Notes from review (newest last; address every one)')
    for (const note of card.notes) lines.push(`- ${note}`)
  }
  if (card.summary !== undefined && card.notes.length > 0) {
    lines.push('')
    lines.push('## Your summary from the previous run')
    lines.push(card.summary.trim())
  }
  lines.push('')
  lines.push('## How to work')
  lines.push(`- Your working directory is ${cwd}. Work only inside it.`)
  if (project.type === 'repo') {
    lines.push(`- You are on branch ${branchFor(card)} in a git worktree made for this card. Commit your work to this branch with clear messages.`)
    lines.push('- Do not switch branches, merge, rebase onto other branches, or push. Kanbot merges the branch after review.')
  } else if (project.type === 'workspace') {
    const repos = reposFor(project, card)
    lines.push(`- Your working directory mirrors the workspace ${project.path}: each folder in it is a git worktree of that repo, on branch ${branchFor(card)}.`)
    lines.push(`- The repos you may change: ${repos.map(r => r.name).join(', ')}. Other repos of the workspace are not here; if the work needs one, stop and say so.`)
    lines.push('- Commit in each repo you change, with clear messages. Leave repos you do not need untouched.')
    lines.push('- Do not switch branches, merge, rebase onto other branches, or push. Kanbot merges each changed repo after review.')
  } else {
    lines.push('- This is a plain working folder, not a git repository. Save what you produce as files in it.')
  }
  lines.push('- Track your steps with your task list (TaskCreate and TaskUpdate, or TodoWrite) so progress shows on the board.')
  lines.push('- If something blocks you, stop and say exactly what you need instead of guessing.')
  lines.push('- Finish with a short summary: what changed, the files touched, how to verify it, and anything left open.')
  return lines.join('\n')
}

export function mergePrompt(project: Project, card: Card): string {
  if (project.type === 'workspace') return workspaceMergePrompt(project, card)
  const branch = card.branch ?? branchFor(card)
  const base = project.baseBranch
  const steps = [
    `Kanbot: merge card ${card.id} ("${card.title}") for the project "${project.name}".`,
    `Repository: ${project.path}. Base branch: ${base}. Card branch: ${branch}.`,
    '',
    `1. In ${project.path}, run \`git status\`. If there are uncommitted changes, or the checked-out branch is not ${base}, stop and report that. Change nothing.`,
    `2. Run \`git merge --no-ff ${branch} -m "Merge Kanbot card ${card.id}: ${card.title.replace(/"/g, "'")}"\`. Resolve a conflict only when the right result is clear; otherwise run \`git merge --abort\` and report the conflicting files.`,
  ]
  if (project.testCommand.trim() !== '') {
    steps.push(`3. Run \`${project.testCommand.trim()}\`. If it fails, undo the merge with \`git reset --hard ORIG_HEAD\` and report the failure.`)
  }
  steps.push(`${project.testCommand.trim() !== '' ? 4 : 3}. Do not push, and do not delete branches or worktrees: Kanbot cleans those up.`)
  steps.push('')
  steps.push('End with one line that starts MERGED or NOT MERGED, then a short reason.')
  return steps.join('\n')
}

function workspaceMergePrompt(project: Project, card: Card): string {
  const branch = card.branch ?? branchFor(card)
  const names = card.mergeRepos ?? []
  const repos = (project.repos ?? []).filter(r => names.includes(r.name))
  const message = `Merge Kanbot card ${card.id}: ${card.title.replace(/"/g, "'")}`
  const test = project.testCommand.trim()
  const lines = [
    `Kanbot: merge card ${card.id} ("${card.title}") for the workspace "${project.name}" at ${project.path}.`,
    `Branch ${branch} is merged into each of these repos (folder: base branch):`,
    ...repos.map(r => `- ${r.name}: ${r.baseBranch}`),
    '',
    `1. Check every repo first: in ${project.path}/<repo>, run \`git status\`. If any has uncommitted changes, or its checked-out branch is not its base branch, stop and report that. Merge nothing.`,
    `2. Then, one repo at a time, run \`git merge --no-ff ${branch} -m "${message}"\`. Resolve a conflict only when the right result is clear; otherwise run \`git merge --abort\` in that repo and stop, reporting the conflicting files. Do not merge the remaining repos.`,
  ]
  if (test !== '') {
    lines.push(`3. After each merge, run \`${test}\` in that repo if it applies there. If it fails, undo that merge with \`git reset --hard ORIG_HEAD\` and stop, reporting the failure.`)
  }
  lines.push(`${test !== '' ? 4 : 3}. Do not push, and do not delete branches or worktrees: Kanbot cleans those up.`)
  lines.push('')
  lines.push('End with one line per repo that starts MERGED or NOT MERGED, then the repo and a short reason.')
  return lines.join('\n')
}

export type Counts = { running: number; waiting: number; review: number; queued: number }

export function counts(cards: readonly Card[]): Counts {
  return {
    running: cards.filter(c => c.column === 'running').length,
    waiting: cards.filter(c => c.waiting !== undefined && c.waiting !== '').length,
    review: cards.filter(c => c.column === 'review').length,
    queued: cards.filter(c => c.column === 'queued').length,
  }
}

export function statusLine(c: Counts, isDispatching: boolean | undefined): string {
  const parts = [`${c.running} running`, `${c.queued} queued`]
  if (c.waiting > 0) parts.push(`${c.waiting} waiting`)
  parts.push(`${c.review} review`)
  const who = isDispatching === undefined ? ' · no dispatcher' : isDispatching ? ' · dispatching' : ''
  return `kanbot: ${parts.join(' · ')}${who}`
}

export function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

/** The one-line status under a card's title. */
export function cardMeta(card: Card, projectName: string, now: number): string {
  const bits: string[] = [projectName]
  if (card.mode === 'parallel') bits.push('∥')
  if (card.progress !== undefined && card.progress.total > 0) bits.push(`${card.progress.done}/${card.progress.total}`)
  if (card.column === 'running' && card.activity !== undefined) bits.push(ago(now - card.activity.lastAt))
  if (card.run?.phase === 'merge') bits.push('merging')
  return bits.join(' · ')
}

export function cardFlag(card: Card, now: number): string {
  if (card.waiting !== undefined && card.waiting !== '') return '!'
  if (card.problem !== undefined && card.problem !== '') return '×'
  if (card.column === 'running') {
    const last = card.activity?.lastAt ?? card.run?.startedAt ?? now
    if (now - last > STALL_MS) return '…'
  }
  return ''
}

/** Parses `/kanbot add` text: `title`, `title | brief`, or `project: title | brief`. */
export function parseAdd(args: string, projects: readonly Project[]): { projectId?: string; title: string; brief: string } {
  let rest = args.trim()
  let projectId: string | undefined
  const colon = rest.indexOf(':')
  if (colon > 0) {
    const name = rest.slice(0, colon).trim().toLowerCase()
    const match = projects.find(p => p.name.toLowerCase() === name || p.id === name)
    if (match !== undefined) {
      projectId = match.id
      rest = rest.slice(colon + 1).trim()
    }
  }
  const bar = rest.indexOf('|')
  const title = (bar < 0 ? rest : rest.slice(0, bar)).trim()
  const brief = bar < 0 ? '' : rest.slice(bar + 1).trim()
  return projectId === undefined ? { title, brief } : { projectId, title, brief }
}

/** A card the model proposes from a plan, checked and ready to add to Backlog. */
export type PlannedCard = { title: string; brief: string; acceptance: string[]; mode: Card['mode']; repos?: string[] }

export const MAX_PLANNED = 20

/** Reads a project named at the start of `text` (by name or id); the rest is left over. */
export function leadingProject(text: string, projects: readonly Project[]): { project?: Project; rest: string } {
  const t = text.trim()
  const lower = t.toLowerCase()
  const byLength = [...projects].sort((a, b) => b.name.length - a.name.length)
  for (const p of byLength) {
    for (const name of [p.name.toLowerCase(), p.id.toLowerCase()]) {
      if (name === '' || !lower.startsWith(name)) continue
      const after = t.slice(name.length)
      if (after === '' || /^[\s:]/.test(after)) return { project: p, rest: after.replace(/^[\s:]+/, '').trim() }
    }
  }
  return { rest: t }
}

/** Finds a project by name or id, ignoring case. */
export function findProject(name: string, projects: readonly Project[]): Project | undefined {
  const n = name.trim().toLowerCase()
  return projects.find(p => p.name.toLowerCase() === n || p.id.toLowerCase() === n)
}

/** Checks the queue_cards tool's `cards` against the project; answers the cards, or what is wrong. */
export function checkPlanned(raw: unknown, project: Project): { cards: PlannedCard[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '`cards` must be a non-empty list.' }
  if (raw.length > MAX_PLANNED) return { error: `At most ${MAX_PLANNED} cards at once; merge some steps into one card.` }
  const known = (project.repos ?? []).map(r => r.name)
  const cards: PlannedCard[] = []
  for (const [i, item] of raw.entries()) {
    const at = `Card ${i + 1}`
    if (typeof item !== 'object' || item === null) return { error: `${at} is not an object.` }
    const c = item as Record<string, unknown>
    const title = typeof c.title === 'string' ? c.title.trim() : ''
    if (title === '') return { error: `${at} has no title.` }
    if (title.length > 120) return { error: `${at}'s title is over 120 characters; put the detail in the brief.` }
    const brief = typeof c.brief === 'string' ? c.brief.trim() : ''
    if (brief === '') return { error: `${at} (${title}) has no brief. The agent that runs it cannot see this conversation.` }
    const acceptance = Array.isArray(c.acceptance) ? c.acceptance.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => a.trim()) : []
    const mode = c.mode === 'parallel' ? 'parallel' : 'sequential'
    const card: PlannedCard = { title, brief, acceptance, mode }
    if (project.type === 'workspace' && Array.isArray(c.repos) && c.repos.length > 0) {
      const repos = c.repos.filter((r): r is string => typeof r === 'string')
      const unknown = repos.filter(r => !known.includes(r))
      if (unknown.length > 0) return { error: `${at} (${title}) names repos ${unknown.join(', ')} that ${project.name} does not have. It has: ${known.join(', ')}.` }
      // Every repo is the same as none: the card may change them all.
      if (repos.length < known.length) card.repos = [...new Set(repos)]
    }
    cards.push(card)
  }
  return { cards }
}

/** What the model is asked to do when the person runs `/kanbot queue`. */
export function queuePrompt(project: Project, guidance: string): string {
  const repos = project.type === 'workspace' ? (project.repos ?? []).map(r => r.name) : []
  return [
    `Turn the plan we agreed in this conversation into Kanbot cards for the project "${project.name}" (${project.type}, ${project.path}), and add them with the mcp__kanbot__queue_cards tool.`,
    '',
    'How to split and write them:',
    '- One card per piece of work that can be reviewed and merged on its own, in the order they should run. Prefer a few substantial cards over many tiny ones.',
    '- Each card is run later by a fresh background Claude agent in its own worktree. It cannot see this conversation, so the brief must stand alone: the goal, the files or areas involved, the decisions we made here, constraints, and what done looks like.',
    '- acceptance: one to five checks a reviewer can verify.',
    "- mode: sequential when a card builds on an earlier card (it waits for the cards above it, and only sees their changes once they are merged); parallel when it can run alongside the others.",
    ...(repos.length > 0 ? [`- repos: the repos the card changes, from: ${repos.join(', ')}. Leave it out when a card may change any of them.`] : []),
    '- If this conversation has no clear plan to turn into cards, say so and do not call the tool.',
    '',
    'The cards land in Backlog for review; nothing runs until they are moved to Queued. Afterwards, list the cards you added in one short line each.',
    ...(guidance !== '' ? ['', `Extra guidance: ${guidance}`] : []),
  ].join('\n')
}
