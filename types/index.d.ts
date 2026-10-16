// Kanbot's data model and its $.state contract.

export type ProjectType = 'repo' | 'chat'

export type Project = {
  id: string
  name: string
  type: ProjectType
  /** Absolute folder: a git repo for `repo`, a plain folder for `chat`. */
  path: string
  /** Repo projects: the branch cards branch from and merge into. */
  baseBranch: string
  /** Most cards of this project running at once (chat projects: always 1). */
  maxParallel: number
  /** Optional command the merge agent runs after merging (e.g. `npm test`). */
  testCommand: string
  colour: string
  createdAt: number
}

export type Column = 'backlog' | 'queued' | 'running' | 'review' | 'done'

export type CardMode = 'sequential' | 'parallel'

export type CardRun = {
  /** The background agent working the card, as $.agent.spawn answered it. */
  agentId?: string
  /** `work` does the card; `merge` merges its branch after Done. */
  phase: 'work' | 'merge'
  startedAt: number
  /** Ticks in a row the dispatcher could not find the agent. */
  missing?: number
}

export type Card = {
  id: string
  projectId: string
  title: string
  brief: string
  acceptance: string[]
  /** Notes added when a card is sent back from Review, oldest first. */
  notes: string[]
  mode: CardMode
  column: Column
  /** Order within its column: lower is higher on the board. */
  rank: number
  /** Repo cards: the card's branch and worktree, kept across runs. */
  branch?: string
  worktree?: string
  run?: CardRun
  /** Set when Robert marks a repo card Done; the dispatcher then merges it. */
  mergeRequested?: boolean
  progress?: { done: number; total: number }
  activity?: { lastTool: string; lastAt: number; toolCalls: number; tokens: number }
  /** Why the card needs Robert's attention, if it does. */
  waiting?: string
  /** Claude's final answer from the last run. */
  summary?: string
  /** The last thing that went wrong (a failed merge, a lost agent). */
  problem?: string
  history: { at: number; text: string }[]
  createdAt: number
  updatedAt: number
}

export type Dispatcher = {
  sessionId: string
  heartbeatAt: number
  isPaused: boolean
}

export type Settings = {
  /** Most cards running at once across every project. */
  globalCap: number
}

export type ActivityEntry = { at: number; cardId: string; projectId: string; text: string }

export type ProjectDraft = {
  name: string
  type: ProjectType
  path: string
  baseBranch: string
  maxParallel: string
  testCommand: string
}

export type Tab = 'board' | 'card' | 'projects' | 'activity'

declare module 'claude-code' {
  interface PluginState {
    kanbot: {
      tab: Tab
      /** The card the Card tab shows; '' for none. */
      selected: string
      /** 'all' or a project id. */
      filter: string
      /** The store's last-seen revision: bumping it redraws the board. */
      rev: number
      draft: ProjectDraft
      /** The project the form edits; '' for a new one. */
      editing: string
    }
  }
}
