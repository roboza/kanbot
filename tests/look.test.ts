import { describe, expect, mock, test } from 'claude-code/testing'

import type { Card, Project } from '../types'

// Every tab, drawn with everything a card can show, must be a tree each surface accepts.
const now = Date.now()
const ws: Project = {
  id: 'pws',
  name: 'IdeaJudge 2026',
  type: 'workspace',
  path: '/development/ideajudge-2026',
  baseBranch: '',
  maxParallel: 2,
  testCommand: '',
  colour: 'magenta',
  createdAt: 1,
  repos: [
    { name: 'ideajudge-ui', baseBranch: 'develop' },
    { name: 'ideajudge-services', baseBranch: 'main' },
  ],
}
const busy: Card = {
  id: 'w1',
  projectId: 'pws',
  title: 'Add a usage export to the dashboard',
  brief: 'Export usage as CSV.',
  acceptance: ['CSV has a header row', 'Tests pass'],
  notes: ['Use ISO dates'],
  mode: 'parallel',
  column: 'running',
  rank: 0,
  repos: ['ideajudge-ui'],
  branch: 'kanbot/w1',
  progress: { done: 2, total: 5 },
  activity: { lastTool: 'Edit', lastAt: now - 30_000, toolCalls: 14, tokens: 52_000 },
  waiting: 'Bash was refused: npm test',
  run: { phase: 'work', startedAt: now - 600_000 },
  summary: 'Halfway there.',
  history: [
    { at: now - 600_000, text: 'Queued' },
    { at: now - 590_000, text: 'Started' },
  ],
  createdAt: 1,
  updatedAt: now,
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'kanbot',
  props: { title: 'Kanbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: {} } as never,
  viewport: { columns: 100, rows: 30 } as never,
}

describe('every tab draws', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`board, card, projects and activity (${surface})`, async ($, on) => {
      mock.store(on, {
        'project:pws': ws,
        'card:w1': busy,
        activity: [{ at: now - 5000, projectId: 'pws', cardId: 'w1', text: 'Edit dashboard.tsx' }],
      })
      const ui = await $.ui.mount({ plugin: 'kanbot', surface, ...PANE })
      await ui.resize({ columns: 100, rows: 20, in: 'board' })
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect(await ui.drawn({ in: 'board' })).toMatchObject({ type: 'Box' })
      expect(await ui.find({ in: 'board', text: /Add a usage export/ })).toBeDefined()

      // Running is the third column; the card's title is on row 2.
      await ui.pointer({ type: 'down', x: 43, y: 2, button: 'left', in: 'board' })
      await ui.pointer({ type: 'up', x: 43, y: 2, button: 'left', in: 'board' })
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect(await ui.find({ type: 'Text', text: /Waiting on you: Bash was refused/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2/5 steps' })).toBeDefined()
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
      else expect(await ui.find({ type: 'Text', text: /█+░+/ })).toBeDefined()

      await ui.press({ key: 'tab-projects' })
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect(await ui.find({ type: 'Text', text: /2 repos: ideajudge-ui \(develop\)/ })).toBeDefined()

      await ui.press({ key: 'tab-activity' })
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect(await ui.find({ type: 'Text', text: /Edit dashboard\.tsx/ })).toBeDefined()
      await ui.unmount()
    })
  }
})
