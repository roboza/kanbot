// Kanbot: a global kanban board in Claude Code that hands queued cards to
// background Claude agents across your projects.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Column, Project, ProjectDraft, Tab } from '../types'
import type { BoardProps } from './board-client'
import type { Board } from './data'
import {
  addCard,
  addCards,
  applyUserMove,
  checkProject,
  deleteCard,
  discoverRepos,
  loadBoard,
  nextColour,
  patchCard,
  readActivity,
  removeProject,
  saveProject,
  touch,
} from './data'
import {
  cardForAgent,
  dispatch,
  dispatcherState,
  finished,
  me,
  sawDenied,
  sawTaskMade,
  sawToolCall,
} from './dispatch'
import {
  COLUMNS,
  COLUMN_NAMES,
  DEFAULT_CAP,
  EMPTY_DRAFT,
  ago,
  cardFlag,
  cardMeta,
  checkPlanned,
  counts,
  findProject,
  inColumn,
  isWithin,
  leadingProject,
  newId,
  parseAdd,
  queuePrompt,
  rankAt,
  statusLine,
} from './model'
import { COLUMN_TONE, flagTone, svgBar, textBar } from './style'

const TAB = atom({ plugin: 'kanbot', key: 'tab' } as const, 'board')
const SELECTED = atom({ plugin: 'kanbot', key: 'selected' } as const, '')
const FILTER = atom({ plugin: 'kanbot', key: 'filter' } as const, 'all')
const REV = atom({ plugin: 'kanbot', key: 'rev' } as const, 0)
const DRAFT = atom({ plugin: 'kanbot', key: 'draft' } as const, EMPTY_DRAFT)
const EDITING = atom({ plugin: 'kanbot', key: 'editing' } as const, '')

type E = EngineInterface

const PANE = 'kanbot'
const QUEUE_TOOL = 'mcp__kanbot__queue_cards'
const QUEUE_SPEC = {
  name: 'queue_cards',
  description: [
    "Adds cards to the Kanbot board's Backlog, in order, for the person to review and then queue.",
    'Each card is later run by a background Claude agent that cannot see this conversation, so each brief must stand alone.',
    'Use it when the person asks to put a plan or tasks on Kanbot (for example after /kanbot queue).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: "The Kanbot project's name. Leave it out to use the project this session's folder belongs to." },
      cards: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: 'The cards in the order they should run.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative title, under 120 characters.' },
            brief: { type: 'string', description: 'Self-contained instructions: goal, files or areas, decisions, constraints, what done looks like.' },
            acceptance: { type: 'array', items: { type: 'string' }, description: 'One to five checks a reviewer can verify.' },
            mode: { type: 'string', enum: ['sequential', 'parallel'], description: 'sequential waits for the cards above it; parallel can run alongside them. Default sequential.' },
            repos: { type: 'array', items: { type: 'string' }, description: 'Workspace projects only: the repos this card changes. Leave out for all.' },
          },
          required: ['title', 'brief'],
        },
      },
    },
    required: ['cards'],
  },
  isDeferred: false,
} as const
const TICK_MS = 3000
const HELP = [
  'Kanbot commands:',
  '  /kanbot                      open the board',
  '  /kanbot add <title>          add a card (also "<project>: <title> | <brief>")',
  '  /kanbot queue [project] [notes]  have Claude turn this conversation\'s plan into Backlog cards',
  '  /kanbot work                 make this session the dispatcher that runs cards',
  '  /kanbot pause | resume       stop or restart starting new cards',
  '  /kanbot stop                 stop dispatching from this session',
  '  /kanbot projects             open the Projects tab',
  '  /kanbot help                 this list',
].join('\n')

/** What a person has typed into a field, kept so a redraw does not wipe it. */
const typing = new Map<string, string>()
let lastRev = 0

function isColumn(v: unknown): v is Column {
  return typeof v === 'string' && (COLUMNS as readonly string[]).includes(v)
}

async function openPane($: E, tab?: Tab): Promise<void> {
  if (tab !== undefined) await update($, TAB, () => tab)
  await $.ui.open({ id: PANE, title: 'Kanbot', columns: 110 })
}

function projectForCwd(projects: readonly Project[], cwd: string): Project | undefined {
  const sorted = [...projects].sort((a, b) => b.path.length - a.path.length)
  return sorted.find(p => isWithin(cwd, p.path))
}

async function defaultProject($: E, board: Board): Promise<Project | undefined> {
  const filter = await read($, FILTER)
  const filtered = board.projects.find(p => p.id === filter)
  if (filtered !== undefined) return filtered
  const here = projectForCwd(board.projects, await $.session.cwd())
  if (here !== undefined) return here
  return board.projects.length === 1 ? board.projects[0] : undefined
}

/** Every session: notice other sessions' changes, keep the status line, dispatch if it is ours. */
async function tick($: E): Promise<void> {
  const rev = Number((await $.store.get('rev')) ?? 0)
  if (rev !== lastRev) {
    lastRev = rev
    await update($, REV, () => rev)
  }
  const board = await loadBoard($)
  const state = dispatcherState(board, Date.now())
  if (me.isDispatcher && state === 'mine') await dispatch($, board)
  const after = me.isDispatcher ? await loadBoard($) : board
  const mine = dispatcherState(after, Date.now())
  $.ui.status(
    after.projects.length === 0
      ? 'kanbot: add a project with /kanbot projects'
      : statusLine(counts(after.cards), mine === 'mine' ? true : mine === 'other' ? false : undefined),
  )
}

async function becomeDispatcher($: E, force: boolean): Promise<string> {
  const board = await loadBoard($)
  const state = dispatcherState(board, Date.now())
  if (state === 'other' && !force) {
    const d = board.dispatcher
    const seen = d === undefined ? '' : ` (last heartbeat ${ago(Date.now() - d.heartbeatAt)} ago)`
    return `Another session is already dispatching${seen}. Run /kanbot work force to take over from this one.`
  }
  await $.store.set('dispatcher', { sessionId: me.sessionId, heartbeatAt: Date.now(), isPaused: false })
  me.isDispatcher = true
  await touch($)
  return [
    'This session is now the Kanbot dispatcher: it starts queued cards as background agents and merges cards you mark Done.',
    'Keep it open while cards run. Agents inherit this session\'s permission mode, so use one that allows edits (for example accept edits) or they will stop on refused tools.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    me.sessionId = await $.session.id()
    const d = await $.store.get('dispatcher')
    if (typeof d === 'object' && d !== null && (d as { sessionId?: unknown }).sessionId === me.sessionId) me.isDispatcher = true
    if ((await $.store.get('settings')) === undefined) await $.store.set('settings', { globalCap: DEFAULT_CAP })
    $.clock.every(TICK_MS, () => tick($))
    try {
      await $.command.register({
        name: 'kanbot',
        description: 'Kanbot board: add, work, pause, resume, stop, projects, help',
        argumentHint: '[add <title> | queue [project] | work | pause | resume | stop | projects | help]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`kanbot: could not register /kanbot: ${String(err)}`)
    }
    try {
      await $.tool.register({ ...QUEUE_SPEC })
    } catch (err) {
      $.ui.log(`kanbot: could not register the queue_cards tool: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'kanbot' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const tail = e.args.trim().slice(verb.length).trim()
    switch (verb.toLowerCase()) {
      case '':
        await openPane($)
        return {}
      case 'help':
        return { text: HELP }
      case 'projects':
      case 'project':
        await openPane($, 'projects')
        return {}
      case 'work':
        return { text: await becomeDispatcher($, rest[0] === 'force') }
      case 'pause':
      case 'resume': {
        const d = await $.store.get('dispatcher')
        if (typeof d !== 'object' || d === null) return { text: 'No session is dispatching. Run /kanbot work first.' }
        await $.store.set('dispatcher', { ...(d as object), isPaused: verb === 'pause' })
        await touch($)
        return { text: verb === 'pause' ? 'Kanbot paused: running cards finish, no new ones start.' : 'Kanbot resumed.' }
      }
      case 'stop': {
        if (!me.isDispatcher) return { text: 'This session is not the dispatcher.' }
        await $.store.delete('dispatcher')
        me.isDispatcher = false
        await touch($)
        return { text: 'This session no longer dispatches. Running agents keep going until they finish.' }
      }
      case 'queue':
      case 'plan': {
        const board = await loadBoard($)
        if (board.projects.length === 0) return { text: 'Add a project first: /kanbot projects' }
        const lead = leadingProject(tail, board.projects)
        const project = lead.project ?? (await defaultProject($, board))
        if (project === undefined) {
          return { text: `Which project? Use /kanbot queue <project>. Projects: ${board.projects.map(p => p.name).join(', ')}` }
        }
        // A command hook may not submit (it would wait on its own turn): submit once it has returned.
        const text = queuePrompt(project, lead.rest)
        $.clock.after(0, () => {
          $.prompt.submit({ text }).catch(err => $.ui.log(`kanbot: could not hand the plan to Claude: ${String(err)}`))
        })
        return { text: `Asking Claude to turn this conversation's plan into cards for ${project.name}. They will land in Backlog for you to review.` }
      }
      case 'add': {
        const board = await loadBoard($)
        if (board.projects.length === 0) return { text: 'Add a project first: /kanbot projects' }
        const parsed = parseAdd(tail, board.projects)
        if (parsed.title === '') return { text: 'Usage: /kanbot add <title>, or /kanbot add <project>: <title> | <brief>' }
        const project = board.projects.find(p => p.id === parsed.projectId) ?? (await defaultProject($, board))
        if (project === undefined) {
          return { text: `Which project? Use /kanbot add <project>: ${parsed.title}. Projects: ${board.projects.map(p => p.name).join(', ')}` }
        }
        const card = await addCard($, board, { projectId: project.id, title: parsed.title, brief: parsed.brief })
        return { text: `Added card ${card.id} to ${project.name}'s Backlog: ${card.title}` }
      }
      default:
        return { text: `Unknown: /kanbot ${verb}\n\n${HELP}` }
    }
  })

  // The model adds a plan's cards to Backlog.
  on('tool.call', { tool: QUEUE_TOOL }, async ($, e) => {
    const input = e as unknown as { project?: unknown; cards?: unknown }
    const board = await loadBoard($)
    if (board.projects.length === 0) return { deny: 'Kanbot has no projects yet. Ask the person to add one with /kanbot projects.' }
    const named = typeof input.project === 'string' && input.project.trim() !== '' ? input.project : undefined
    const project = named !== undefined ? findProject(named, board.projects) : await defaultProject($, board)
    if (project === undefined) {
      const list = board.projects.map(p => p.name).join(', ')
      return { deny: named !== undefined ? `No Kanbot project is called "${named}". Projects: ${list}.` : `Say which project with \`project\`. Projects: ${list}.` }
    }
    const checked = checkPlanned(input.cards, project)
    if ('error' in checked) return { deny: checked.error }
    const added = await addCards($, board, project.id, checked.cards, 'Created from a plan')
    $.ui.toast(`Kanbot: ${added.length} card${added.length === 1 ? '' : 's'} added to ${project.name}'s Backlog`)
    return {
      result: [
        `Added ${added.length} card${added.length === 1 ? '' : 's'} to ${project.name}'s Backlog:`,
        ...added.map(c => `- ${c.id} ${c.title} (${c.mode}${c.repos !== undefined ? `; ${c.repos.join(', ')}` : ''})`),
        'They stay in Backlog until the person reviews them and moves them to Queued on the board.',
      ].join('\n'),
    }
  })

  // Follow every tool call a card's agent makes.
  on('tool.call', async ($, e, next) => {
    const cardId = cardForAgent(e.agentId)
    if (cardId === undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    sawToolCall(cardId, tool, input)
    const result = await next(e)
    const r = result as unknown as { deny?: unknown; isError?: unknown }
    if (typeof r.deny === 'string') sawDenied(cardId, tool, r.deny)
    else if (tool === 'TaskCreate' && r.isError !== true) sawTaskMade(cardId)
    return result
  })

  // A card's agent finished: move the card on.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined && cardForAgent(e.agentId) !== undefined) {
      await finished($, e.agentId, { answer: e.answer, reason: e.reason, usage: e.usage })
    }
    return result
  })

  // The drag-and-drop board posts moves and opens.
  on('ui.message', { component: 'Pane', element: 'board' }, async ($, e) => {
    const data = e.data as { type?: unknown; id?: unknown; col?: unknown; index?: unknown }
    if (typeof data !== 'object' || data === null || typeof data.id !== 'string') return {}
    if (data.type === 'open') {
      await update($, SELECTED, () => data.id as string)
      await update($, TAB, () => 'card')
      return {}
    }
    if (data.type === 'move' && isColumn(data.col) && typeof data.index === 'number') {
      const board = await loadBoard($)
      const filter = await read($, FILTER)
      const others = inColumn(board.cards, data.col, filter === 'all' ? undefined : filter).filter(c => c.id !== data.id)
      const said = await applyUserMove($, board, data.id, data.col, rankAt(others, data.index))
      if (said !== undefined) $.ui.toast(said)
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      return <Text>Kanbot's board needs the terminal or the Code tab of the desktop app.</Text>
    }
    const { Input, Select, Markdown, Client } = $.ui.resolve(e)
    // Svg is drawn by the desktop only; the terminal gets text bars instead.
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : undefined
    await read($, REV)
    const tab = await read($, TAB)
    const board = await loadBoard($)
    const now = Date.now()
    const projectName = (id: string) => board.projects.find(p => p.id === id)?.name ?? '?'
    const go = (t: Tab) => () => void update($, TAB, () => t)
    const toast = (said: string | undefined) => {
      if (said !== undefined) $.ui.toast(said)
    }
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 100

    const isDesktop = e.surface === 'desktop'
    /** A small filled label: a status, a project, a column. */
    const chip = (key: string, text: string, tone: string) => (
      <Text key={key} color="inverseText" backgroundColor={tone} wrap="truncate-end">{` ${text} `}</Text>
    )
    /** A bordered section with a heading. */
    const panel = (key: string, title: string, children: RenderChildren, tone = 'subtle') => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={tone} borderDimColor={tone === 'subtle'} paddingX={1} marginTop={1}>
        <Text size="footnote" weight="semibold" color={tone === 'subtle' ? 'subtle' : tone}>{title.toUpperCase()}</Text>
        {children}
      </Box>
    )

    const ds = dispatcherState(board, now)
    const paused = board.dispatcher?.isPaused === true
    const [who, whoTone] =
      ds === 'mine'
        ? paused ? ['● paused here', 'warning'] : ['● dispatching here', 'success']
        : ds === 'other'
          ? ['● dispatched elsewhere', 'suggestion']
          : ds === 'stale'
            ? ['○ dispatcher gone', 'error']
            : ['○ no dispatcher', 'error']
    const tally = counts(board.cards)

    const tabButton = (t: Tab, label: string, hotkey: string) => {
      const active = tab === t
      return isDesktop ? (
        <Button key={`tab-${t}`} label={label} hotkey={hotkey} variant={active ? 'primary' : 'secondary'} onPress={go(t)} />
      ) : (
        <Button key={`tab-${t}`} hotkey={hotkey} plain dimColor={!active} onPress={go(t)}>
          <Text bold={active} color={active ? 'claude' : undefined} underline={active}>
            {label}
          </Text>
        </Button>
      )
    }

    const titleBar = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={2}>
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Text size="title" weight="bold" color="claude">
            ◆ Kanbot
          </Text>
          <Box flexDirection="row" columnGap={2} borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
            {tabButton('board', 'Board', 'b')}
            {tabButton('card', 'Card', 'c')}
            {tabButton('projects', 'Projects', 'p')}
            {tabButton('activity', 'Activity', 'a')}
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {tally.waiting > 0 && chip('chip-waiting', `${tally.waiting} waiting on you`, 'warning')}
          <Text size="footnote" dimColor tabular wrap="truncate-end">
            {`${tally.running} running · ${tally.queued} queued · ${tally.review} review`}
          </Text>
          {chip('chip-dispatcher', who, whoTone)}
        </Box>
      </Box>
    )

    let body
    if (tab === 'board') body = await boardTab()
    else if (tab === 'card') body = await cardTab()
    else if (tab === 'projects') body = await projectsTab()
    else body = await activityTab()

    return (
      <Box flexDirection="column">
        {titleBar}
        {body}
      </Box>
    )

    async function boardTab() {
      if (board.projects.length === 0) {
        return panel(
          'welcome',
          'Get started',
          <Box flexDirection="column" rowGap={1}>
            <Text wrap="wrap">No projects yet. A project points Kanbot at a repo, a workspace of repos, or a plain working folder.</Text>
            <Box flexDirection="row">
              <Button key="go-projects" label="Set up a project" variant="primary" onPress={go('projects')} />
            </Box>
          </Box>,
          'claude',
        )
      }
      const filter = await read($, FILTER)
      const selected = await read($, SELECTED)
      const shown = filter === 'all' ? board.cards : board.cards.filter(c => c.projectId === filter)
      const cols: BoardProps['cols'] = COLUMNS.map(col => {
        const list = inColumn(shown, col)
        return {
          key: col,
          name: COLUMN_NAMES[col],
          tone: COLUMN_TONE[col],
          count: list.length,
          cards: list.slice(0, 40).map(c => ({
            id: c.id,
            title: c.title,
            meta: cardMeta(c, projectName(c.projectId), now),
            flag: cardFlag(c, now),
            flagTone: flagTone(cardFlag(c, now)),
            colour: board.projects.find(p => p.id === c.projectId)?.colour ?? 'white',
            selected: c.id === selected,
          })),
        }
      })
      const rows = Math.max(12, (e.viewport?.rows ?? 30) - 11)
      const options = [{ value: 'all', label: 'All projects' }, ...board.projects.map(p => ({ value: p.id, label: p.name }))]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} marginTop={1} alignItems="center">
            <Select key="filter" label="Show" options={options} value={filter} onSelect={v => void update($, FILTER, () => v)} />
            <Input
              key="new-card"
              label="New card"
              placeholder={filter === 'all' ? '<project>: <title> | <brief>' : '<title> | <brief>'}
              value={typing.get('new-card') ?? ''}
              submitLabel="add"
              onInput={v => typing.set('new-card', v)}
              onSubmit={async v => {
                const fresh = await loadBoard($)
                const parsed = parseAdd(v, fresh.projects)
                if (parsed.title === '') return
                const project = fresh.projects.find(p => p.id === parsed.projectId) ?? (await defaultProject($, fresh))
                if (project === undefined) {
                  $.ui.toast('Pick a project in Show, or start with "<project>: "')
                  return
                }
                typing.delete('new-card')
                await addCard($, fresh, { projectId: project.id, title: parsed.title, brief: parsed.brief })
              }}
            />
          </Box>
          <Box marginTop={1}>
            <Client key="board" module="./board-client.tsx" props={{ cols, rows, columns: width }} width="100%" height={rows} />
          </Box>
          <Text size="footnote" dimColor wrap="truncate-end">
            Drag cards between columns · click to open · Backlog → Queued starts a card · Review → Done merges it
          </Text>
        </Box>
      )
    }

    async function cardTab() {
      const id = await read($, SELECTED)
      const card = board.cards.find(c => c.id === id)
      if (card === undefined) {
        return panel('no-card', 'Card', <Text dimColor>Click a card on the Board to open it here.</Text>)
      }
      const project = board.projects.find(p => p.id === card.projectId)
      const move = (to: Column) => async () => toast(await applyUserMove($, await loadBoard($), card.id, to, undefined, typing.get(`note-${card.id}`)))
      const nudge = (delta: -1 | 1) => async () => {
        const fresh = await loadBoard($)
        const list = inColumn(fresh.cards, card.column).filter(c => c.id !== card.id)
        const here = inColumn(fresh.cards, card.column).findIndex(c => c.id === card.id)
        await patchCard($, card.id, c => ({ ...c, rank: rankAt(list, Math.max(0, here + delta)) }))
      }
      const actions = []
      if (card.column === 'backlog') {
        actions.push(<Button key="act-queue" label="Queue" hotkey="q" variant="primary" onPress={move('queued')} />)
        actions.push(
          <Button
            key="act-delete" variant="secondary"
            label="Delete"
            onPress={async () => {
              await deleteCard($, card)
              await update($, SELECTED, () => '')
            }}
          />,
        )
      }
      if (card.column === 'queued') actions.push(<Button key="act-unqueue" variant="secondary" label="Back to Backlog" onPress={move('backlog')} />)
      if (card.column === 'backlog' || card.column === 'queued') {
        actions.push(<Button key="act-up" variant="secondary" label="Up" hotkey="u" onPress={nudge(-1)} />)
        actions.push(<Button key="act-down" variant="secondary" label="Down" hotkey="d" onPress={nudge(1)} />)
        actions.push(
          <Button
            key="act-mode" variant="secondary"
            label={card.mode === 'sequential' ? 'Make parallel' : 'Make sequential'}
            onPress={() => void patchCard($, card.id, c => ({ ...c, mode: c.mode === 'sequential' ? 'parallel' : 'sequential' }))}
          />,
        )
      }
      if (card.column === 'review' && card.run?.phase !== 'merge') {
        actions.push(<Button key="act-done" label={card.mergeRequested === true ? 'Merge queued' : 'Done'} hotkey="y" variant="primary" onPress={move('done')} />)
        actions.push(<Button key="act-back" variant="secondary" label="Send back" onPress={move('queued')} />)
        actions.push(<Button key="act-discard" variant="secondary" label="Discard" onPress={move('backlog')} />)
      }
      const editable = card.column === 'backlog' || card.column === 'queued' || card.column === 'review'
      const progress = card.progress
      const stats = [
        card.activity !== undefined ? `${card.activity.toolCalls} tool calls` : '',
        card.activity !== undefined ? `last ${card.activity.lastTool} ${ago(now - card.activity.lastAt)} ago` : '',
        card.activity !== undefined ? `${Math.round(card.activity.tokens / 1000)}k tokens` : '',
        card.run !== undefined ? `${card.run.phase === 'merge' ? 'merging' : 'running'} for ${ago(now - card.run.startedAt)}` : '',
      ].filter(s => s !== '')
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={project?.colour}>▌</Text>
            <Text size="heading" weight="bold" wrap="wrap">
              {card.title}
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap" marginTop={1}>
            {chip('chip-project', project?.name ?? '?', project?.colour ?? 'subtle')}
            {chip('chip-column', COLUMN_NAMES[card.column], COLUMN_TONE[card.column])}
            {chip('chip-mode', card.mode === 'parallel' ? '∥ parallel' : '→ sequential', 'subtle')}
            <Text size="footnote" dimColor mono wrap="truncate-middle">
              {`${card.id}${card.branch !== undefined ? ` · ${card.branch}` : ''}`}
            </Text>
          </Box>
          {card.waiting !== undefined && card.waiting !== '' && (
            <Box borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
              <Text color="warning" wrap="wrap">{`! Waiting on you: ${card.waiting}`}</Text>
            </Box>
          )}
          {card.problem !== undefined && card.problem !== '' && (
            <Box borderStyle="round" borderColor="error" paddingX={1} marginTop={1}>
              <Text color="error" wrap="wrap">{`× ${card.problem}`}</Text>
            </Box>
          )}
          {actions.length > 0 && (
            <Box flexDirection="row" columnGap={2} rowGap={1} flexWrap="wrap" marginTop={1}>
              {actions}
            </Box>
          )}
          {card.column === 'review' && card.run?.phase !== 'merge' && (
            <Box marginTop={1}>
              <Input
                key={`note-${card.id}`}
                label="Note for Send back"
                placeholder="What should Claude change?"
                value={typing.get(`note-${card.id}`) ?? ''}
                submitLabel="send back"
                onInput={v => typing.set(`note-${card.id}`, v)}
                onSubmit={async v => {
                  typing.delete(`note-${card.id}`)
                  toast(await applyUserMove($, await loadBoard($), card.id, 'queued', undefined, v))
                }}
              />
            </Box>
          )}
          {project?.type === 'workspace' &&
            panel(
              'sec-repos',
              `Repos${card.repos === undefined || card.repos.length === 0 ? ' · all' : ''}`,
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={2} flexWrap="wrap">
                  {(project.repos ?? []).map(r => {
                    const picked = card.repos === undefined || card.repos.length === 0 || card.repos.includes(r.name)
                    const canPick = card.column === 'backlog' || card.column === 'queued'
                    const label = `${picked ? '☑' : '☐'} ${r.name}`
                    return canPick ? (
                      <Button
                        key={`repo-${card.id}-${r.name}`}
                        plain
                        onPress={() =>
                          void patchCard($, card.id, c => {
                            const all = (project.repos ?? []).map(x => x.name)
                            const now = c.repos === undefined || c.repos.length === 0 ? all : c.repos
                            const next = now.includes(r.name) ? now.filter(n => n !== r.name) : [...now, r.name]
                            return { ...c, repos: next.length === 0 || next.length === all.length ? undefined : next }
                          })
                        }
                      >
                        <Text bold={picked} color={picked ? 'success' : undefined} dimColor={!picked}>
                          {label}
                        </Text>
                      </Button>
                    ) : (
                      <Text key={`repo-${card.id}-${r.name}`} bold={picked} color={picked ? 'success' : undefined} dimColor={!picked}>
                        {label}
                      </Text>
                    )
                  })}
                </Box>
                {card.mergeRepos !== undefined && card.mergeRepos.length > 0 && (
                  <Text color="warning" wrap="wrap">{`Still to merge: ${card.mergeRepos.join(', ')}`}</Text>
                )}
              </Box>,
            )}
          {panel(
            'sec-brief',
            'Brief',
            editable ? (
              <Input
                key={`brief-${card.id}`}
                placeholder="What Claude should do"
                value={typing.get(`brief-${card.id}`) ?? card.brief}
                submitLabel="save"
                onInput={v => typing.set(`brief-${card.id}`, v)}
                onSubmit={async v => {
                  typing.delete(`brief-${card.id}`)
                  await patchCard($, card.id, c => ({ ...c, brief: v }))
                }}
              />
            ) : (
              <Markdown key={`brief-md-${card.id}`} text={card.brief === '' ? card.title : card.brief} />
            ),
          )}
          {panel(
            'sec-acceptance',
            `Acceptance · ${card.acceptance.length}`,
            <Box flexDirection="column">
              {card.acceptance.length === 0 && !editable && <Text dimColor>None.</Text>}
              {card.acceptance.map((item, i) => (
                <Box key={`acc-${i}`} flexDirection="row" columnGap={1}>
                  <Text color="success">✓</Text>
                  <Box flexGrow={1}>
                    <Text wrap="wrap">{item}</Text>
                  </Box>
                  {editable && (
                    <Button
                      key={`acc-x-${card.id}-${i}`}
                      label="✕"
                      plain
                      dimColor
                      onPress={() => void patchCard($, card.id, c => ({ ...c, acceptance: c.acceptance.filter((_, j) => j !== i) }))}
                    />
                  )}
                </Box>
              ))}
              {editable && (
                <Input
                  key={`acc-new-${card.id}`}
                  label="Add"
                  placeholder="A check Claude must satisfy"
                  value={typing.get(`acc-${card.id}`) ?? ''}
                  submitLabel="add"
                  onInput={v => typing.set(`acc-${card.id}`, v)}
                  onSubmit={async v => {
                    typing.delete(`acc-${card.id}`)
                    if (v.trim() === '') return
                    await patchCard($, card.id, c => ({ ...c, acceptance: [...c.acceptance, v.trim()] }))
                  }}
                />
              )}
            </Box>,
          )}
          {card.notes.length > 0 &&
            panel(
              'sec-notes',
              'Review notes',
              <Box flexDirection="column">
                {card.notes.map((n, i) => (
                  <Text key={`note-${i}`} wrap="wrap">{`- ${n}`}</Text>
                ))}
              </Box>,
              'warning',
            )}
          {panel(
            'sec-progress',
            'Progress',
            <Box flexDirection="column">
              {progress !== undefined && progress.total > 0 ? (
                <Box flexDirection="row" columnGap={1} alignItems="center">
                  {Svg !== undefined ? (
                    <Svg source={svgBar(progress.done, progress.total)} alt={`${progress.done} of ${progress.total} steps done`} width={240} height={8} />
                  ) : (
                    <Text color="claude">{textBar(progress.done, progress.total, 20)}</Text>
                  )}
                  <Text tabular>{`${progress.done}/${progress.total} steps`}</Text>
                </Box>
              ) : (
                <Text dimColor>No steps yet.</Text>
              )}
              {stats.length > 0 && (
                <Text size="footnote" dimColor tabular wrap="wrap">
                  {stats.join(' · ')}
                </Text>
              )}
            </Box>,
          )}
          {card.summary !== undefined &&
            card.summary !== '' &&
            panel('sec-summary', 'Summary from Claude', <Markdown key={`summary-${card.id}`} text={card.summary} />, 'claude')}
          {panel(
            'sec-history',
            'History',
            <Box flexDirection="column">
              {card.history.slice(-8).map((entry, i) => (
                <Box key={`h-${i}`} flexDirection="row" columnGap={1}>
                  <Box width={5}>
                    <Text size="footnote" dimColor tabular>
                      {ago(now - entry.at)}
                    </Text>
                  </Box>
                  <Text size="footnote" wrap="truncate-end">
                    {entry.text}
                  </Text>
                </Box>
              ))}
            </Box>,
          )}
        </Box>
      )
    }

    async function projectsTab() {
      const draft = await read($, DRAFT)
      const editing = await read($, EDITING)
      const set = (field: Exclude<keyof ProjectDraft, 'type'>) => (v: string) => void update($, DRAFT, d => ({ ...d, [field]: v }))
      const edit = (p: Project) => async () => {
        await update($, EDITING, () => p.id)
        await update($, DRAFT, () => ({
          name: p.name,
          type: p.type,
          path: p.path,
          baseBranch: p.baseBranch,
          maxParallel: String(p.maxParallel),
          testCommand: p.testCommand,
        }))
      }
      const clear = async () => {
        await update($, EDITING, () => '')
        await update($, DRAFT, () => EMPTY_DRAFT)
      }
      const save = async () => {
        const fresh = await loadBoard($)
        const old = fresh.projects.find(p => p.id === editing)
        const max = Number.parseInt(draft.maxParallel, 10)
        const project: Project = {
          id: old?.id ?? `p${newId(Date.now(), Math.random())}`,
          name: draft.name.trim(),
          type: draft.type,
          path: draft.path.trim().replace(/[\\/]+$/, ''),
          baseBranch: draft.baseBranch.trim() === '' ? 'main' : draft.baseBranch.trim(),
          maxParallel: Number.isFinite(max) && max > 0 ? max : 2,
          testCommand: draft.testCommand.trim(),
          colour: old?.colour ?? nextColour(fresh.projects),
          createdAt: old?.createdAt ?? Date.now(),
        }
        if (project.type === 'workspace') {
          // Saving scans the folder again, so new repos are picked up.
          project.repos = await discoverRepos($, project.path)
          project.baseBranch = ''
        }
        const problem = await checkProject($, project)
        if (problem !== undefined) {
          $.ui.toast(problem)
          return
        }
        await saveProject($, project)
        $.ui.toast(
          project.type === 'workspace'
            ? `Saved ${project.name}: found ${(project.repos ?? []).map(r => r.name).join(', ')}`
            : `Saved ${project.name}`,
        )
        await clear()
      }
      const cap = board.settings.globalCap
      /** One row of the form: the label in a fixed column, the control beside it. */
      const field = (key: string, label: string, control: RenderChildren) => (
        <Box key={key} flexDirection="row" columnGap={2} alignItems="center">
          <Box width={16} flexShrink={0}>
            <Text dimColor wrap="truncate-end">
              {label}
            </Text>
          </Box>
          <Box flexGrow={1}>{control}</Box>
        </Box>
      )
      return (
        <Box flexDirection="column">
          {panel(
            'sec-projects',
            `Projects · ${board.projects.length}`,
            <Box flexDirection="column">
              {board.projects.length === 0 && <Text dimColor>None yet.</Text>}
              {board.projects.map(p => {
                const open = board.cards.filter(c => c.projectId === p.id && c.column !== 'done').length
                const running = board.cards.filter(c => c.projectId === p.id && c.column === 'running').length
                const detail =
                  p.type === 'repo'
                    ? `base ${p.baseBranch} · up to ${p.maxParallel} in parallel`
                    : p.type === 'workspace'
                      ? `${(p.repos ?? []).length} repos: ${(p.repos ?? []).map(r => `${r.name} (${r.baseBranch})`).join(', ')} · up to ${p.maxParallel} in parallel`
                      : 'one card at a time · no git'
                return (
                  <Box
                    key={`proj-${p.id}`}
                    flexDirection="column"
                    borderStyle="round"
                    borderColor={p.id === editing ? 'suggestion' : p.colour}
                    borderDimColor={p.id !== editing}
                    hover={{ borderColor: 'suggestion', borderDimColor: false }}
                    paddingX={1}
                  >
                    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                      <Box flexDirection="row" columnGap={1} alignItems="center">
                        <Button key={`proj-edit-${p.id}`} plain onPress={edit(p)}>
                          <Text color={p.colour} bold>
                            {p.name}
                          </Text>
                        </Button>
                        {chip(`proj-type-${p.id}`, p.type, 'subtle')}
                      </Box>
                      <Box flexDirection="row" columnGap={1}>
                        {running > 0 && chip(`proj-run-${p.id}`, `${running} running`, 'claude')}
                        <Text dimColor tabular>{`${open} open`}</Text>
                      </Box>
                    </Box>
                    <Text size="footnote" dimColor mono wrap="truncate-middle">
                      {p.path}
                    </Text>
                    <Text size="footnote" dimColor wrap="wrap">
                      {detail}
                    </Text>
                  </Box>
                )
              })}
              {board.projects.length > 0 && (
                <Text size="footnote" dimColor>
                  Click a project's name to edit it.
                </Text>
              )}
            </Box>,
          )}
          {panel(
            'sec-form',
            editing === '' ? 'New project' : `Edit ${draft.name}`,
            <Box flexDirection="column" rowGap={1}>
              {field('f-name', 'Name', <Input key="pf-name" placeholder="IdeaJudge" value={draft.name} onInput={set('name')} onSubmit={save} />)}
              {field(
                'f-type',
                'Type',
                <Select
                  key="pf-type"
                  options={[
                    { value: 'repo', label: 'Repo: a git repository; cards get branches and are merged on Done' },
                    { value: 'workspace', label: 'Workspace: a parent folder of several repos; cards can change any of them' },
                    { value: 'chat', label: 'Chat: a plain folder; cards run one at a time, no git' },
                  ]}
                  value={draft.type}
                  onSelect={v =>
                    void update($, DRAFT, (d): ProjectDraft => ({ ...d, type: v === 'chat' ? 'chat' : v === 'workspace' ? 'workspace' : 'repo' }))
                  }
                />,
              )}
              {field(
                'f-path',
                'Folder',
                <Input key="pf-path" placeholder="/Users/you/work/project (absolute)" value={draft.path} onInput={set('path')} onSubmit={save} />,
              )}
              {draft.type === 'repo' &&
                field(
                  'f-base',
                  'Base branch',
                  <Input key="pf-base" placeholder="main" value={draft.baseBranch} onInput={set('baseBranch')} onSubmit={save} />,
                )}
              {draft.type !== 'chat' &&
                field(
                  'f-max',
                  'Max parallel',
                  <Input key="pf-max" placeholder="2" value={draft.maxParallel} onInput={set('maxParallel')} onSubmit={save} />,
                )}
              {draft.type !== 'chat' &&
                field(
                  'f-test',
                  'Test command',
                  <Input
                    key="pf-test"
                    placeholder={draft.type === 'workspace' ? 'optional; run in each merged repo where it applies' : 'npm test (optional, run after merging)'}
                    value={draft.testCommand}
                    onInput={set('testCommand')}
                    onSubmit={save}
                  />,
                )}
              {draft.type === 'workspace' && (
                <Text size="footnote" dimColor wrap="wrap">
                  Kanbot finds the git repos directly inside the folder, and each repo's base branch, when you save. Save again later to pick up new repos.
                </Text>
              )}
              <Box flexDirection="row" columnGap={2}>
                <Button key="pf-save" label="Save" variant="primary" onPress={save} />
                {editing !== '' && <Button key="pf-new" label="New project" variant="secondary" onPress={clear} />}
                {editing !== '' && (
                  <Button
                    key="pf-remove"
                    label="Remove"
                    variant="secondary"
                    onPress={async () => {
                      const fresh = await loadBoard($)
                      const p = fresh.projects.find(x => x.id === editing)
                      if (p === undefined) return
                      const said = await removeProject($, p, fresh)
                      if (said !== undefined) $.ui.toast(said)
                      else await clear()
                    }}
                  />
                )}
              </Box>
            </Box>,
            editing === '' ? 'subtle' : 'suggestion',
          )}
          {panel(
            'sec-dispatcher',
            'Dispatcher',
            <Box flexDirection="column" rowGap={1}>
              <Box flexDirection="row" columnGap={1} alignItems="center">
                {chip('disp-chip', who, whoTone)}
                <Text dimColor wrap="wrap">
                  {ds === 'mine'
                    ? 'This session runs the cards. Keep it open.'
                    : 'Run /kanbot work in the session that should run cards. Keep it open; its agents inherit its permission mode.'}
                </Text>
              </Box>
              {field(
                'f-cap',
                'Running at once',
                <Input
                  key="cap"
                  placeholder="4"
                  value={typing.get('cap') ?? String(cap)}
                  submitLabel="save"
                  onInput={v => typing.set('cap', v)}
                  onSubmit={async v => {
                    typing.delete('cap')
                    const n = Number.parseInt(v, 10)
                    if (!Number.isFinite(n) || n < 1 || n > 16) {
                      $.ui.toast('Use a number from 1 to 16.')
                      return
                    }
                    await $.store.set('settings', { globalCap: n })
                    await touch($)
                  }}
                />,
              )}
              <Text size="footnote" dimColor>
                Across all projects, 1 to 16.
              </Text>
            </Box>,
          )}
        </Box>
      )
    }

    async function activityTab() {
      const list = (await readActivity($)).slice(-60).reverse()
      const titleOf = (id: string) => board.cards.find(c => c.id === id)?.title ?? id
      return panel(
        'sec-activity',
        'Activity',
        <Box flexDirection="column">
          {list.length === 0 && <Text dimColor>Nothing yet. Activity appears once the dispatcher runs cards.</Text>}
          {list.map((a, i) => {
            const colour = board.projects.find(p => p.id === a.projectId)?.colour
            return (
              <Box key={`act-${i}`} flexDirection="row" columnGap={1}>
                <Box width={4} flexShrink={0}>
                  <Text size="footnote" dimColor tabular>
                    {ago(now - a.at)}
                  </Text>
                </Box>
                <Text color={colour}>▌</Text>
                <Text wrap="truncate-end">
                  <Text color={colour} bold>{`${projectName(a.projectId)} `}</Text>
                  <Text dimColor>{`${titleOf(a.cardId).slice(0, Math.max(10, Math.floor(width / 4)))} · `}</Text>
                  {a.text}
                </Text>
              </Box>
            )
          })}
        </Box>,
      )
    }
  })
}
