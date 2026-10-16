import { describe, expect, mock, test } from 'claude-code/testing'

import type { Card, Project } from '../types'

const project: Project = {
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
const card = (id: string, over: Partial<Card>): Card => ({
  id,
  projectId: 'pij',
  title: `Card ${id}`,
  brief: '',
  acceptance: [],
  notes: [],
  mode: 'sequential',
  column: 'backlog',
  rank: 0,
  history: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const seed = () => ({
  'project:pij': project,
  'card:b1': card('b1', { column: 'backlog', title: 'Fix login' }),
  'card:r1': card('r1', { column: 'running', title: 'Add export', run: { phase: 'work', startedAt: Date.now() } }),
  'card:v1': card('v1', { column: 'review', title: 'Tidy README', summary: 'Rewrote the README.' }),
})

/** The number on a column's badge. */
async function count(ui: { find: (q: { in: string; key: string }) => Promise<{ text?: string } | undefined> }, col: string) {
  const text = (await ui.find({ in: 'board', key: `${col}-head` }))?.text ?? ''
  return Number(/(\d+)\s*$/.exec(text)?.[1])
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'kanbot',
  props: { title: 'Kanbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: {} } as never,
  viewport: { columns: 100, rows: 30 } as never,
}

describe('board pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws the five columns with the cards (${surface})`, async ($, on) => {
      mock.store(on, seed())
      const ui = await $.ui.mount({ plugin: 'kanbot', surface, ...PANE })
      await ui.resize({ columns: 100, rows: 20, in: 'board' })
      expect(await ui.find({ type: 'Client', key: 'board' })).toBeDefined()
      for (const [col, n] of [['backlog', 1], ['queued', 0], ['running', 1], ['review', 1], ['done', 0]] as const) {
        expect(await count(ui, col)).toBe(n)
      }
      expect(await ui.find({ in: 'board', text: 'Backlog' })).toBeDefined()
      expect(await ui.find({ in: 'board', text: /Fix login/ })).toBeDefined()
      await ui.unmount()
    })

    test(`dragging Backlog to Queued queues the card (${surface})`, async ($, on) => {
      mock.store(on, seed())
      const toasts: string[] = []
      on('ui.toast', async (_$, e) => {
        toasts.push(JSON.stringify(e))
        return { value: null } as never
      })
      const ui = await $.ui.mount({ plugin: 'kanbot', surface, ...PANE })
      await ui.resize({ columns: 100, rows: 20, in: 'board' })
      // Columns are 20 wide; the first card's title is on row 2.
      await ui.pointer({ type: 'down', x: 3, y: 2, button: 'left', in: 'board' })
      await ui.pointer({ type: 'move', x: 25, y: 3, button: 'left', in: 'board' })
      await ui.pointer({ type: 'up', x: 25, y: 3, button: 'left', in: 'board' })
      expect(await count(ui, 'queued')).toBe(1)
      expect(await count(ui, 'backlog')).toBe(0)
      expect(toasts).toEqual([])
      await ui.unmount()
    })

    test(`dragging a running card is refused with a reason (${surface})`, async ($, on) => {
      mock.store(on, seed())
      const toasts: string[] = []
      on('ui.toast', async (_$, e) => {
        toasts.push(JSON.stringify(e))
        return { value: null } as never
      })
      const ui = await $.ui.mount({ plugin: 'kanbot', surface, ...PANE })
      await ui.resize({ columns: 100, rows: 20, in: 'board' })
      await ui.pointer({ type: 'down', x: 43, y: 2, button: 'left', in: 'board' })
      await ui.pointer({ type: 'move', x: 65, y: 2, button: 'left', in: 'board' })
      await ui.pointer({ type: 'up', x: 65, y: 2, button: 'left', in: 'board' })
      expect(await count(ui, 'running')).toBe(1)
      expect(toasts.join(' ')).toContain('moves to Review by itself')
      await ui.unmount()
    })

    test(`clicking a card opens it in the Card tab (${surface})`, async ($, on) => {
      mock.store(on, seed())
      const ui = await $.ui.mount({ plugin: 'kanbot', surface, ...PANE })
      await ui.resize({ columns: 100, rows: 20, in: 'board' })
      await ui.pointer({ type: 'down', x: 63, y: 2, button: 'left', in: 'board' })
      await ui.pointer({ type: 'up', x: 63, y: 2, button: 'left', in: 'board' })
      expect(await ui.find({ type: 'Text', text: 'Tidy README' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'act-done' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'act-back' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('Send back with a note requeues the card at the top with the note', async ($, on) => {
    mock.store(on, seed())
    const ui = await $.ui.mount({ plugin: 'kanbot', surface: 'desktop', ...PANE })
    await ui.resize({ columns: 100, rows: 20, in: 'board' })
    await ui.pointer({ type: 'down', x: 63, y: 2, button: 'left', in: 'board' })
    await ui.pointer({ type: 'up', x: 63, y: 2, button: 'left', in: 'board' })
    await ui.input({ key: 'note-v1', text: 'Add a usage section' })
    expect(await ui.find({ type: 'Text', text: /^ Queued $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '- Add a usage section' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'act-unqueue' })).toBeDefined()
    await ui.unmount()
  })

  test('the Projects tab refuses a folder that does not exist', async ($, on) => {
    mock.store(on, {})
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(JSON.stringify(e))
      return { value: null } as never
    })
    on('fs.stat', async () => ({ deny: 'ENOENT: no such file or directory' }) as never)
    const ui = await $.ui.mount({ plugin: 'kanbot', surface: 'terminal', ...PANE })
    await ui.press({ key: 'go-projects' })
    await ui.input({ key: 'pf-name', text: 'Nowhere', kind: 'change' })
    await ui.input({ key: 'pf-path', text: '/no/such/folder', kind: 'change' })
    await ui.press({ key: 'pf-save' })
    expect(toasts.join(' ')).toContain('does not exist')
    expect(await ui.find({ type: 'Text', text: 'None yet.' })).toBeDefined()
    await ui.unmount()
  })

  test('saving a workspace finds the repos inside it, Windows paths included', async ($, on) => {
    mock.store(on, {})
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(JSON.stringify(e))
      return { value: null } as never
    })
    on('fs.stat', async () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }) as never)
    on('fs.list', async () =>
      ({
        value: [
          { name: 'ideajudge-ui', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'ideajudge-services', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'docs', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: '.vscode', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'notes.md', kind: 'file', size: 0, mtimeMs: 0, isLink: false },
        ],
      }) as never,
    )
    on('process.run', async (_$, e) => {
      const argv = (e as unknown as { argv: string[] }).argv
      const dir = argv[2] ?? ''
      const name = dir.split('/').pop() ?? ''
      const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
      const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
      if (argv[3] === 'rev-parse') {
        // git on Windows answers with the drive letter; docs/ is not a repo.
        return name === 'docs' ? fail() : ok(`C:/development/ideajudge-2026/${name}\n`)
      }
      if (argv[3] === 'symbolic-ref') return name === 'ideajudge-ui' ? ok('origin/develop\n') : fail()
      if (argv[3] === 'branch') return ok('main\n')
      return fail()
    })
    const ui = await $.ui.mount({ plugin: 'kanbot', surface: 'desktop', ...PANE })
    await ui.press({ key: 'go-projects' })
    await ui.input({ key: 'pf-name', text: 'IdeaJudge 2026', kind: 'change' })
    await ui.select({ key: 'pf-type', value: 'workspace' })
    await ui.input({ key: 'pf-path', text: '/development/ideajudge-2026', kind: 'change' })
    await ui.press({ key: 'pf-save' })
    expect(toasts.join(' ')).toContain('found ideajudge-services, ideajudge-ui')
    expect(await ui.find({ type: 'Text', text: /2 repos: ideajudge-services \(main\), ideajudge-ui \(develop\)/ })).toBeDefined()
    await ui.unmount()
  })
})
