// The board's drag-and-drop region: a Client surface module. It draws the five
// columns, follows the pointer, and posts `move` and `open` to the hooks module.
import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

export type CardView = { id: string; title: string; meta: string; flag: string; colour: string; selected: boolean }
export type ColView = { key: string; name: string; count: number; cards: CardView[] }
export type BoardProps = { cols: ColView[] }

type Drag = { id: string; fromCol: number; fromIdx: number; sx: number; sy: number; x: number; y: number }
type S = { drag?: Drag; armed: boolean }

/** Rows above the first card: the column name and a rule. */
export const HEAD = 2
/** Rows per card: title, status line, gap. */
export const CARD_H = 3

let latest: BoardProps = { cols: [] }
let surf: ClientSurface<S> | undefined

export function colWidth(columns: number, n: number): number {
  return Math.max(6, Math.floor(columns / Math.max(1, n)))
}

/** How many cards fit in a column of `rows` rows (one row kept for "+n more"). */
export function fit(rows: number): number {
  return Math.max(1, Math.floor((rows - HEAD - 1) / CARD_H))
}

/** Which column a point is over, and the slot it would drop into. */
export function hit(props: BoardProps, columns: number, rows: number, x: number, y: number): { col: number; idx: number; onCard: boolean } {
  const n = props.cols.length
  const w = colWidth(columns, n)
  const col = Math.max(0, Math.min(n - 1, Math.floor(x / w)))
  const shown = Math.min(props.cols[col]?.cards.length ?? 0, fit(rows))
  const rel = y - HEAD
  if (rel < 0) return { col, idx: 0, onCard: false }
  const slot = Math.floor(rel / CARD_H)
  const onCard = slot < shown && rel % CARD_H < 2
  // Dropping in the lower half of a card puts the dragged card after it.
  const idx = Math.max(0, Math.min(shown, slot + (rel % CARD_H >= 1 ? 1 : 0)))
  return { col, idx, onCard }
}

function onPointer(ev: ClientPointerEvent): void {
  const s = surf
  if (s === undefined) return
  const state = s.state ?? { armed: true }
  const at = hit(latest, s.columns, s.rows, ev.x, ev.y)
  if (ev.type === 'down' && ev.button === 'left') {
    const card = at.onCard ? latest.cols[at.col]?.cards[Math.floor((ev.y - HEAD) / CARD_H)] : undefined
    if (card === undefined) return
    s.setState({ ...state, drag: { id: card.id, fromCol: at.col, fromIdx: Math.floor((ev.y - HEAD) / CARD_H), sx: ev.x, sy: ev.y, x: ev.x, y: ev.y } })
    return
  }
  const drag = state.drag
  if (drag === undefined) return
  if (ev.type === 'move') {
    s.setState({ ...state, drag: { ...drag, x: ev.x, y: ev.y } })
    return
  }
  if (ev.type === 'up') {
    const moved = Math.abs(ev.x - drag.sx) + Math.abs(ev.y - drag.sy) >= 2
    const target = latest.cols[at.col]
    if (!moved) {
      s.post({ type: 'open', id: drag.id })
    } else if (target !== undefined) {
      // Slots count the cards as drawn, the dragged one included: leave it out.
      const idx = at.col === drag.fromCol && at.idx > drag.fromIdx ? at.idx - 1 : at.idx
      if (!(at.col === drag.fromCol && idx === drag.fromIdx)) s.post({ type: 'move', id: drag.id, col: target.key, index: idx })
    }
    s.setState({ ...state, drag: undefined })
  }
}

const Board: ClientModule<BoardProps, S> = (props, surface) => {
  latest = props
  surf = surface
  if (surface.state === undefined) {
    surface.onPointer(onPointer)
    surface.setState({ armed: true })
  }
  const { Box, Text } = surface.elements
  const n = props.cols.length
  const w = colWidth(surface.columns, n)
  const room = fit(surface.rows)
  const drag = surface.state?.drag
  const over = drag === undefined ? undefined : hit(props, surface.columns, surface.rows, drag.x, drag.y)

  return (
    <Box flexDirection="row">
      {props.cols.map((col, ci) => {
        const isTarget = over !== undefined && over.col === ci && !(drag !== undefined && drag.fromCol === ci && over.idx === drag.fromIdx)
        const shown = col.cards.slice(0, room)
        const hidden = col.cards.length - shown.length
        return (
          <Box key={col.key} flexDirection="column" width={w}>
            <Text bold inverse={isTarget} wrap="truncate-end">
              {` ${col.name} ${col.count}`}
            </Text>
            <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(1, w - 1))}</Text>
            {shown.map((card, i) => {
              const dragging = drag?.id === card.id
              const dropHere = isTarget && over?.idx === i
              return (
                <Box key={card.id} flexDirection="column" width={w}>
                  <Text bold={card.selected} color={card.colour} dimColor={dragging} underline={dropHere} wrap="truncate-end">
                    {`${card.flag === '' ? ' ' : card.flag}${card.title}`}
                  </Text>
                  <Text dimColor wrap="truncate-end">{` ${card.meta}`}</Text>
                  <Text> </Text>
                </Box>
              )
            })}
            {hidden > 0 && <Text dimColor wrap="truncate-end">{` +${hidden} more`}</Text>}
            {isTarget && over !== undefined && over.idx >= shown.length && (
              <Text dimColor wrap="truncate-end">{' ▸ drop here'}</Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default Board
