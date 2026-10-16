// Kanbot's records in $.store, one key per record so sessions writing
// different cards never overwrite each other, and the actions on them.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActivityEntry, Card, Column, Dispatcher, Project, Settings, WorkspaceRepo } from '../types'
import {
  DEFAULT_CAP,
  PROJECT_COLOURS,
  bottomRank,
  branchFor,
  isWithin,
  joinPath,
  newId,
  reposFor,
  topRank,
  userMove,
  worktreeFor,
} from './model'

type E = EngineInterface

const REV = atom({ plugin: 'kanbot', key: 'rev' } as const, 0)

export type Board = {
  projects: Project[]
  cards: Card[]
  dispatcher?: Dispatcher
  settings: Settings
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export async function loadBoard($: E): Promise<Board> {
  const keys = await $.store.keys()
  const projects: Project[] = []
  const cards: Card[] = []
  for (const key of keys) {
    if (key.startsWith('project:')) {
      const v = await $.store.get(key)
      if (isObject(v)) projects.push(v as Project)
    } else if (key.startsWith('card:')) {
      const v = await $.store.get(key)
      if (isObject(v)) cards.push(v as Card)
    }
  }
  projects.sort((a, b) => a.createdAt - b.createdAt)
  const d = await $.store.get('dispatcher')
  const s = await $.store.get('settings')
  const settings: Settings = isObject(s) && typeof s.globalCap === 'number' ? (s as Settings) : { globalCap: DEFAULT_CAP }
  return isObject(d) ? { projects, cards, dispatcher: d as Dispatcher, settings } : { projects, cards, settings }
}

/** Tells every session the board changed: each redraws on its next tick, this one now. */
export async function touch($: E): Promise<void> {
  const rev = Date.now()
  await $.store.set('rev', rev)
  await update($, REV, () => rev)
}

export async function getCard($: E, id: string): Promise<Card | undefined> {
  const v = await $.store.get(`card:${id}`)
  return isObject(v) ? (v as Card) : undefined
}

export async function getProject($: E, id: string): Promise<Project | undefined> {
  const v = await $.store.get(`project:${id}`)
  return isObject(v) ? (v as Project) : undefined
}

/** Reads the card again, applies `fn`, writes it: never from a stale copy. */
export async function patchCard($: E, id: string, fn: (card: Card) => Card | undefined): Promise<Card | undefined> {
  const card = await getCard($, id)
  if (card === undefined) return undefined
  const next = fn(card)
  if (next === undefined) return undefined
  const saved = { ...next, updatedAt: Date.now() }
  await $.store.set(`card:${id}`, saved)
  await touch($)
  return saved
}

export function withHistory(card: Card, text: string): Card {
  return { ...card, history: [...card.history, { at: Date.now(), text }].slice(-30) }
}

export async function logActivity($: E, entries: ActivityEntry[]): Promise<void> {
  if (entries.length === 0) return
  const v = await $.store.get('activity')
  const list = Array.isArray(v) ? (v as ActivityEntry[]) : []
  await $.store.set('activity', [...list, ...entries].slice(-200))
}

export async function readActivity($: E): Promise<ActivityEntry[]> {
  const v = await $.store.get('activity')
  return Array.isArray(v) ? (v as ActivityEntry[]) : []
}

export async function addCard(
  $: E,
  board: Board,
  input: { projectId: string; title: string; brief: string; acceptance?: string[]; mode?: Card['mode']; repos?: string[]; origin?: string },
): Promise<Card> {
  const now = Date.now()
  const card: Card = {
    id: newId(now, Math.random()),
    projectId: input.projectId,
    title: input.title,
    brief: input.brief,
    acceptance: input.acceptance ?? [],
    notes: [],
    mode: input.mode ?? 'sequential',
    column: 'backlog',
    rank: bottomRank(board.cards, 'backlog'),
    history: [{ at: now, text: input.origin ?? 'Created' }],
    createdAt: now,
    updatedAt: now,
  }
  if (input.repos !== undefined) card.repos = input.repos
  await $.store.set(`card:${card.id}`, card)
  await touch($)
  return card
}

/** Adds cards to the bottom of Backlog in the order given. */
export async function addCards(
  $: E,
  board: Board,
  projectId: string,
  cards: readonly { title: string; brief: string; acceptance: string[]; mode: Card['mode']; repos?: string[] }[],
  origin: string,
): Promise<Card[]> {
  const added: Card[] = []
  let seen = board
  for (const c of cards) {
    const card = await addCard($, seen, { projectId, ...c, origin })
    added.push(card)
    seen = { ...seen, cards: [...seen.cards, card] }
  }
  return added
}

export async function deleteCard($: E, card: Card): Promise<void> {
  await $.store.delete(`card:${card.id}`)
  await touch($)
}

export async function saveProject($: E, project: Project): Promise<void> {
  await $.store.set(`project:${project.id}`, project)
  await touch($)
}

export async function removeProject($: E, project: Project, board: Board): Promise<string | undefined> {
  const live = board.cards.filter(c => c.projectId === project.id && c.column !== 'done')
  if (live.length > 0) return `${project.name} still has ${live.length} open card(s). Finish or delete them first.`
  for (const c of board.cards.filter(c => c.projectId === project.id)) await $.store.delete(`card:${c.id}`)
  await $.store.delete(`project:${project.id}`)
  await touch($)
  return undefined
}

export function nextColour(projects: readonly Project[]): string {
  return PROJECT_COLOURS[projects.length % PROJECT_COLOURS.length] ?? 'cyan'
}

/** Checks a project's folder before it is saved; answers the problem, or undefined. */
export async function checkProject($: E, p: Project): Promise<string | undefined> {
  if (p.name.trim() === '') return 'Give the project a name.'
  if (!p.path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p.path)) return 'The folder must be an absolute path.'
  try {
    const st = await $.fs.stat(p.path)
    if (st.kind !== 'dir') return `${p.path} is not a folder.`
  } catch {
    return `${p.path} does not exist.`
  }
  if (p.type === 'workspace') {
    if ((p.repos ?? []).length === 0) return `No git repos found inside ${p.path}. Each repo must be a folder directly inside it.`
    return undefined
  }
  if (p.type === 'repo') {
    const inside = await git($, p.path, ['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0) return `${p.path} is not a git repository. Use a chat project for plain folders.`
    const base = await git($, p.path, ['rev-parse', '--verify', '--quiet', p.baseBranch])
    if (base.exitCode !== 0) return `The base branch "${p.baseBranch}" does not exist in ${p.path}.`
  }
  return undefined
}

export async function git($: E, cwd: string, args: string[], timeoutMs = 60_000) {
  try {
    return await $.process.run(['git', '-C', cwd, ...args], { timeoutMs })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err), isStdoutTruncated: false, isStderrTruncated: false }
  }
}

/** A repo's base branch: what origin's HEAD points at, else the checked-out branch, else main. */
async function baseOf($: E, repo: string): Promise<string> {
  const head = await git($, repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head.exitCode === 0 && head.stdout.trim() !== '') return head.stdout.trim().replace(/^origin\//, '')
  const current = await git($, repo, ['branch', '--show-current'])
  return current.exitCode === 0 && current.stdout.trim() !== '' ? current.stdout.trim() : 'main'
}

/** The git repos directly inside a workspace folder, each with its base branch. */
export async function discoverRepos($: E, path: string): Promise<WorkspaceRepo[]> {
  let entries: { name: string; kind: string }[]
  try {
    entries = (await $.fs.list(path)) as { name: string; kind: string }[]
  } catch {
    return []
  }
  const repos: WorkspaceRepo[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const dir = joinPath(path, entry.name)
    // Only a repo's own top folder counts, not a folder inside the parent's repo.
    const top = await git($, dir, ['rev-parse', '--show-toplevel'])
    const root = top.stdout.trim()
    if (top.exitCode !== 0 || !isWithin(root, dir) || !isWithin(dir, root)) continue
    repos.push({ name: entry.name, baseBranch: await baseOf($, dir) })
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A workspace card's folder: one worktree per repo it may change, each on the
 * card's branch, laid out as in the workspace.
 */
export async function ensureWorkspace(
  $: E,
  project: Project,
  card: Card,
): Promise<{ path: string; branch: string; touched: string[] } | { problem: string }> {
  const branch = card.branch ?? branchFor(card)
  const folder = card.worktree ?? worktreeFor(project, card)
  const repos = reposFor(project, card)
  if (repos.length === 0) return { problem: `${project.name} has no repos. Open the project and save it again to find them.` }
  const touched = new Set(card.touched ?? [])
  for (const repo of repos) {
    const source = joinPath(project.path, repo.name)
    const target = joinPath(folder, repo.name)
    if (await $.fs.exists(target)) {
      touched.add(repo.name)
      continue
    }
    const has = await git($, source, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    const made =
      has.exitCode === 0
        ? await git($, source, ['worktree', 'add', target, branch])
        : await git($, source, ['worktree', 'add', '-b', branch, target, repo.baseBranch])
    if (made.exitCode !== 0) return { problem: `Could not make the ${repo.name} worktree: ${made.stderr.trim().slice(0, 300)}` }
    touched.add(repo.name)
  }
  return { path: folder, branch, touched: [...touched] }
}

/** The repos of a workspace card whose branch has commits its base does not. */
export async function reposWithWork($: E, project: Project, card: Card): Promise<string[]> {
  const branch = card.branch ?? branchFor(card)
  const out: string[] = []
  for (const name of card.touched ?? []) {
    const repo = (project.repos ?? []).find(r => r.name === name)
    if (repo === undefined) continue
    const r = await git($, joinPath(project.path, name), ['rev-list', '--count', `${repo.baseBranch}..${branch}`])
    if (r.exitCode === 0 && Number.parseInt(r.stdout.trim(), 10) > 0) out.push(name)
  }
  return out
}

/** Removes one workspace repo's worktree and the card's branch there. */
export async function removeRepoWorktree($: E, project: Project, card: Card, name: string, deleteBranch: 'merged' | 'force'): Promise<void> {
  const source = joinPath(project.path, name)
  if (card.worktree !== undefined) await git($, source, ['worktree', 'remove', '--force', joinPath(card.worktree, name)])
  await git($, source, ['worktree', 'prune'])
  await git($, source, ['branch', deleteBranch === 'force' ? '-D' : '-d', card.branch ?? branchFor(card)])
}

/** Makes (or finds) the card's worktree on its branch; answers its path, or a problem. */
export async function ensureWorktree($: E, project: Project, card: Card): Promise<{ path: string; branch: string } | { problem: string }> {
  const branch = card.branch ?? branchFor(card)
  const path = card.worktree ?? worktreeFor(project, card)
  if (await $.fs.exists(path)) return { path, branch }
  const has = await git($, project.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const made =
    has.exitCode === 0
      ? await git($, project.path, ['worktree', 'add', path, branch])
      : await git($, project.path, ['worktree', 'add', '-b', branch, path, project.baseBranch])
  if (made.exitCode !== 0) return { problem: `Could not make the worktree: ${made.stderr.trim().slice(0, 300)}` }
  return { path, branch }
}

export async function removeWorktree($: E, project: Project, card: Card, deleteBranch: 'merged' | 'force'): Promise<void> {
  if (project.type === 'workspace') {
    for (const name of card.touched ?? []) await removeRepoWorktree($, project, card, name, deleteBranch)
    return
  }
  if (card.worktree !== undefined) await git($, project.path, ['worktree', 'remove', '--force', card.worktree])
  await git($, project.path, ['worktree', 'prune'])
  if (card.branch !== undefined) await git($, project.path, ['branch', deleteBranch === 'force' ? '-D' : '-d', card.branch])
}

/** Whether a workspace repo's base branch already holds the card's branch. */
export async function isRepoMerged($: E, project: Project, card: Card, name: string): Promise<boolean> {
  const repo = (project.repos ?? []).find(r => r.name === name)
  if (repo === undefined) return false
  const r = await git($, joinPath(project.path, name), ['merge-base', '--is-ancestor', card.branch ?? branchFor(card), repo.baseBranch])
  return r.exitCode === 0
}

export async function isMerged($: E, project: Project, card: Card): Promise<boolean> {
  const branch = card.branch ?? branchFor(card)
  const r = await git($, project.path, ['merge-base', '--is-ancestor', branch, project.baseBranch])
  return r.exitCode === 0
}

/**
 * A person moved a card (dragged, a button, a command). Answers a sentence to
 * show when the move was refused or needs saying, else undefined.
 */
export async function applyUserMove(
  $: E,
  board: Board,
  cardId: string,
  to: Column,
  rank: number | undefined,
  note?: string,
): Promise<string | undefined> {
  const card = board.cards.find(c => c.id === cardId)
  if (card === undefined) return 'That card is gone.'
  const project = board.projects.find(p => p.id === card.projectId)
  const action = userMove(card, to)
  const at = rank ?? (to === 'queued' && action.kind === 'sendback' ? topRank(board.cards, 'queued') : bottomRank(board.cards, to))
  switch (action.kind) {
    case 'deny':
      return action.reason
    case 'reorder':
      await patchCard($, card.id, c => ({ ...c, rank: at }))
      return undefined
    case 'queue':
      await patchCard($, card.id, c => withHistory({ ...c, column: 'queued', rank: at, problem: undefined }, 'Queued'))
      return undefined
    case 'unqueue':
      await patchCard($, card.id, c => withHistory({ ...c, column: 'backlog', rank: at }, 'Back to Backlog'))
      return undefined
    case 'sendback': {
      const text = note?.trim() ?? ''
      await patchCard($, card.id, c =>
        withHistory(
          {
            ...c,
            column: 'queued',
            rank: at,
            notes: text === '' ? c.notes : [...c.notes, text],
            run: undefined,
            mergeRepos: undefined,
            waiting: undefined,
            problem: undefined,
          },
          text === '' ? 'Sent back' : `Sent back: ${text}`,
        ),
      )
      return undefined
    }
    case 'discard': {
      if (project !== undefined && project.type !== 'chat') await removeWorktree($, project, card, 'force')
      await patchCard($, card.id, c =>
        withHistory(
          {
            ...c,
            column: 'backlog',
            rank: at,
            branch: undefined,
            worktree: undefined,
            touched: undefined,
            mergeRepos: undefined,
            run: undefined,
            summary: undefined,
            progress: undefined,
            waiting: undefined,
            problem: undefined,
          },
          'Discarded the work; back to Backlog',
        ),
      )
      return undefined
    }
    case 'done': {
      if (project === undefined || project.type === 'chat' || card.branch === undefined) {
        await patchCard($, card.id, c => withHistory({ ...c, column: 'done', rank: at, waiting: undefined }, 'Done'))
        return undefined
      }
      await patchCard($, card.id, c =>
        withHistory({ ...c, mergeRequested: true, problem: undefined }, 'Done: waiting for the merge'),
      )
      return 'Merging: the card moves to Done once its branch is merged.'
    }
  }
}
