// Kanbot: a global kanban board in Claude Code that hands queued cards to
// background Claude agents across your projects.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Column, Project, ProjectDraft, Tab } from '../types'
import type { BoardProps } from './board-client'
import type { Board } from './data'
import {
  addCard,
  applyUserMove,
  checkProject,
  deleteCard,
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
  counts,
  inColumn,
  newId,
  parseAdd,
  rankAt,
  statusLine,
} from './model'

const TAB = atom({ plugin: 'kanbot', key: 'tab' } as const, 'board')
const SELECTED = atom({ plugin: 'kanbot', key: 'selected' } as const, '')
const FILTER = atom({ plugin: 'kanbot', key: 'filter' } as const, 'all')
const REV = atom({ plugin: 'kanbot', key: 'rev' } as const, 0)
const DRAFT = atom({ plugin: 'kanbot', key: 'draft' } as const, EMPTY_DRAFT)
const EDITING = atom({ plugin: 'kanbot', key: 'editing' } as const, '')

type E = EngineInterface

const PANE = 'kanbot'
const TICK_MS = 3000
const HELP = [
  'Kanbot commands:',
  '  /kanbot                      open the board',
  '  /kanbot add <title>          add a card (also "<project>: <title> | <brief>")',
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
  return sorted.find(p => cwd === p.path || cwd.startsWith(p.path.replace(/\/+$/, '') + '/'))
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
        argumentHint: '[add <title> | work | pause | resume | stop | projects | help]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`kanbot: could not register /kanbot: ${String(err)}`)
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

    const ds = dispatcherState(board, now)
    const who =
      ds === 'mine'
        ? board.dispatcher?.isPaused === true ? 'dispatching here · paused' : 'dispatching here'
        : ds === 'other'
          ? 'dispatched by another session'
          : ds === 'stale'
            ? 'dispatcher gone: run /kanbot work'
            : 'no dispatcher: run /kanbot work'

    const tabs = (
      <Box flexDirection="row" columnGap={3}>
        <Button key="tab-board" label="Board" hotkey="b" plain dimColor={tab !== 'board'} onPress={go('board')} />
        <Button key="tab-card" label="Card" hotkey="c" plain dimColor={tab !== 'card'} onPress={go('card')} />
        <Button key="tab-projects" label="Projects" hotkey="p" plain dimColor={tab !== 'projects'} onPress={go('projects')} />
        <Button key="tab-activity" label="Activity" hotkey="a" plain dimColor={tab !== 'activity'} onPress={go('activity')} />
        <Text dimColor wrap="truncate-end">{who}</Text>
      </Box>
    )

    let body
    if (tab === 'board') body = await boardTab()
    else if (tab === 'card') body = await cardTab()
    else if (tab === 'projects') body = await projectsTab()
    else body = await activityTab()

    return (
      <Box flexDirection="column">
        {tabs}
        <Text> </Text>
        {body}
      </Box>
    )

    async function boardTab() {
      if (board.projects.length === 0) {
        return (
          <Box flexDirection="column">
            <Text>No projects yet. A project points Kanbot at a repo folder or a plain working folder.</Text>
            <Button key="go-projects" label="Set up a project" variant="primary" onPress={go('projects')} />
          </Box>
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
          count: list.length,
          cards: list.slice(0, 40).map(c => ({
            id: c.id,
            title: c.title,
            meta: cardMeta(c, projectName(c.projectId), now),
            flag: cardFlag(c, now),
            colour: board.projects.find(p => p.id === c.projectId)?.colour ?? 'white',
            selected: c.id === selected,
          })),
        }
      })
      const rows = Math.max(12, (e.viewport?.rows ?? 30) - 10)
      const options = [{ value: 'all', label: 'All projects' }, ...board.projects.map(p => ({ value: p.id, label: p.name }))]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
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
          <Text> </Text>
          <Client key="board" module="./board-client.tsx" props={{ cols }} width="100%" height={rows} />
          <Text dimColor wrap="truncate-end">
            Drag cards between columns. Click a card to open it. Backlog → Queued starts it; Review → Done merges it.
          </Text>
        </Box>
      )
    }

    async function cardTab() {
      const id = await read($, SELECTED)
      const card = board.cards.find(c => c.id === id)
      if (card === undefined) {
        return <Text dimColor>Click a card on the Board to open it here.</Text>
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
            key="act-delete"
            label="Delete"
            onPress={async () => {
              await deleteCard($, card)
              await update($, SELECTED, () => '')
            }}
          />,
        )
      }
      if (card.column === 'queued') actions.push(<Button key="act-unqueue" label="Back to Backlog" onPress={move('backlog')} />)
      if (card.column === 'backlog' || card.column === 'queued') {
        actions.push(<Button key="act-up" label="Up" hotkey="u" onPress={nudge(-1)} />)
        actions.push(<Button key="act-down" label="Down" hotkey="d" onPress={nudge(1)} />)
        actions.push(
          <Button
            key="act-mode"
            label={card.mode === 'sequential' ? 'Make parallel' : 'Make sequential'}
            onPress={() => void patchCard($, card.id, c => ({ ...c, mode: c.mode === 'sequential' ? 'parallel' : 'sequential' }))}
          />,
        )
      }
      if (card.column === 'review' && card.run?.phase !== 'merge') {
        actions.push(<Button key="act-done" label={card.mergeRequested === true ? 'Merge queued' : 'Done'} hotkey="y" variant="primary" onPress={move('done')} />)
        actions.push(<Button key="act-back" label="Send back" onPress={move('queued')} />)
        actions.push(<Button key="act-discard" label="Discard" onPress={move('backlog')} />)
      }
      const editable = card.column === 'backlog' || card.column === 'queued' || card.column === 'review'
      return (
        <Box flexDirection="column">
          <Text bold color={project?.colour} wrap="wrap">
            {card.title}
          </Text>
          <Text dimColor wrap="truncate-end">
            {`${card.id} · ${project?.name ?? '?'} · ${COLUMN_NAMES[card.column]} · ${card.mode}${card.branch !== undefined ? ` · ${card.branch}` : ''}`}
          </Text>
          {card.waiting !== undefined && card.waiting !== '' && <Text color="yellow" wrap="wrap">{`! ${card.waiting}`}</Text>}
          {card.problem !== undefined && card.problem !== '' && <Text color="red" wrap="wrap">{`× ${card.problem}`}</Text>}
          <Text> </Text>
          {actions.length > 0 && (
            <Box flexDirection="row" columnGap={2} flexWrap="wrap">
              {actions}
            </Box>
          )}
          {card.column === 'review' && card.run?.phase !== 'merge' && (
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
          )}
          <Text> </Text>
          <Text bold>Brief</Text>
          {editable ? (
            <Input
              key={`brief-${card.id}`}
              label="Brief"
              rows={4}
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
          )}
          <Text> </Text>
          <Text bold>{`Acceptance (${card.acceptance.length})`}</Text>
          {card.acceptance.map((item, i) => (
            <Box key={`acc-${i}`} flexDirection="row" columnGap={1}>
              {editable && (
                <Button
                  key={`acc-x-${card.id}-${i}`}
                  label="x"
                  plain
                  onPress={() => void patchCard($, card.id, c => ({ ...c, acceptance: c.acceptance.filter((_, j) => j !== i) }))}
                />
              )}
              <Text wrap="wrap">{`- ${item}`}</Text>
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
          {card.notes.length > 0 && (
            <Box flexDirection="column">
              <Text> </Text>
              <Text bold>Review notes</Text>
              {card.notes.map((n, i) => (
                <Text key={`note-${i}`} wrap="wrap">{`- ${n}`}</Text>
              ))}
            </Box>
          )}
          <Text> </Text>
          <Text bold>Progress</Text>
          <Text dimColor wrap="wrap">
            {[
              card.progress !== undefined ? `${card.progress.done}/${card.progress.total} steps` : 'no steps yet',
              card.activity !== undefined
                ? `${card.activity.toolCalls} tool calls · last ${card.activity.lastTool} ${ago(now - card.activity.lastAt)} ago · ${Math.round(card.activity.tokens / 1000)}k tokens`
                : '',
              card.run !== undefined ? `${card.run.phase === 'merge' ? 'merging' : 'running'} for ${ago(now - card.run.startedAt)}` : '',
            ]
              .filter(s => s !== '')
              .join(' · ')}
          </Text>
          {card.summary !== undefined && card.summary !== '' && (
            <Box flexDirection="column">
              <Text> </Text>
              <Text bold>Summary from Claude</Text>
              <Markdown key={`summary-${card.id}`} text={card.summary} />
            </Box>
          )}
          <Text> </Text>
          <Text bold>History</Text>
          {card.history.slice(-8).map((entry, i) => (
            <Text key={`h-${i}`} dimColor wrap="truncate-end">{`${ago(now - entry.at)} ago  ${entry.text}`}</Text>
          ))}
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
        const problem = await checkProject($, project)
        if (problem !== undefined) {
          $.ui.toast(problem)
          return
        }
        await saveProject($, project)
        $.ui.toast(`Saved ${project.name}`)
        await clear()
      }
      const cap = board.settings.globalCap
      return (
        <Box flexDirection="column">
          <Text bold>Projects</Text>
          {board.projects.length === 0 && <Text dimColor>None yet.</Text>}
          {board.projects.map(p => {
            const open = board.cards.filter(c => c.projectId === p.id && c.column !== 'done').length
            return (
              <Box key={`proj-${p.id}`} flexDirection="row" columnGap={2}>
                <Button key={`proj-edit-${p.id}`} plain onPress={edit(p)}>
                  <Text color={p.colour} bold={p.id === editing}>
                    {p.name}
                  </Text>
                </Button>
                <Text dimColor wrap="truncate-middle">
                  {`${p.type} · ${p.path}${p.type === 'repo' ? ` · ${p.baseBranch} · max ${p.maxParallel}` : ''} · ${open} open`}
                </Text>
              </Box>
            )
          })}
          <Text> </Text>
          <Text bold>{editing === '' ? 'New project' : `Edit ${draft.name}`}</Text>
          <Input key="pf-name" label="Name" placeholder="IdeaJudge" value={draft.name} onInput={set('name')} onSubmit={save} />
          <Select
            key="pf-type"
            label="Type"
            options={[
              { value: 'repo', label: 'Repo: a git repository; cards get branches and are merged on Done' },
              { value: 'chat', label: 'Chat: a plain folder; cards run one at a time, no git' },
            ]}
            value={draft.type}
            onSelect={v => void update($, DRAFT, (d): ProjectDraft => ({ ...d, type: v === 'chat' ? 'chat' : 'repo' }))}
          />
          <Input key="pf-path" label="Folder" placeholder="/Users/you/work/project (absolute)" value={draft.path} onInput={set('path')} onSubmit={save} />
          {draft.type === 'repo' && (
            <Box flexDirection="column">
              <Input key="pf-base" label="Base branch" placeholder="main" value={draft.baseBranch} onInput={set('baseBranch')} onSubmit={save} />
              <Input key="pf-max" label="Max parallel" placeholder="2" value={draft.maxParallel} onInput={set('maxParallel')} onSubmit={save} />
              <Input key="pf-test" label="Test command" placeholder="npm test (optional, run after merging)" value={draft.testCommand} onInput={set('testCommand')} onSubmit={save} />
            </Box>
          )}
          <Box flexDirection="row" columnGap={2}>
            <Button key="pf-save" label="Save" variant="primary" onPress={save} />
            {editing !== '' && <Button key="pf-new" label="New project" onPress={clear} />}
            {editing !== '' && (
              <Button
                key="pf-remove"
                label="Remove"
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
          <Text> </Text>
          <Text bold>Dispatcher</Text>
          <Text dimColor wrap="wrap">
            {ds === 'mine'
              ? 'This session runs the cards. Keep it open.'
              : 'Run /kanbot work in the session that should run cards. Keep that session open; its agents inherit its permission mode.'}
          </Text>
          <Input
            key="cap"
            label="Most cards running at once (all projects)"
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
          />
        </Box>
      )
    }

    async function activityTab() {
      const list = (await readActivity($)).slice(-60).reverse()
      const titleOf = (id: string) => board.cards.find(c => c.id === id)?.title ?? id
      return (
        <Box flexDirection="column">
          <Text bold>Activity</Text>
          {list.length === 0 && <Text dimColor>Nothing yet. Activity appears once the dispatcher runs cards.</Text>}
          {list.map((a, i) => (
            <Text key={`act-${i}`} wrap="truncate-end">
              <Text dimColor>{`${ago(now - a.at).padStart(4)} `}</Text>
              <Text color={board.projects.find(p => p.id === a.projectId)?.colour}>{`${projectName(a.projectId)} `}</Text>
              <Text dimColor>{`${titleOf(a.cardId).slice(0, Math.max(10, Math.floor(width / 4)))}: `}</Text>
              {a.text}
            </Text>
          ))}
        </Box>
      )
    }
  })
}
