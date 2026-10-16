// The board's drag-and-drop region: a Client surface module. It draws the five
// columns, follows the pointer, and posts `move` and `open` to the hooks module.
import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

export type CardView = {
  id: string
  title: string
  meta: string
  flag: string
  /** Theme key the flag is drawn in. */
  flagTone: string
  colour: string
  selected: boolean
}
/** `tone` is the theme key the column's name and badge are drawn in. */
export type ColView = { key: string; name: string; tone: string; count: number; cards: CardView[] }
/** `rows` and `columns`: the size the pane asked for, used until the region has been laid out. */
export type BoardProps = { cols: ColView[]; rows?: number; columns?: number }

type Drag = { id: string; fromCol: number; fromIdx: number; sx: number; sy: number; x: number; y: number }
type S = { drag?: Drag; armed: boolean }

/** Rows above the first card: the column's name and a rule. */
export const HEAD = 2
/** Rows per card: title, status line, gap. */
export const CARD_H = 3

let latest: BoardProps = { cols: [] }
let surf: ClientSurface<S> | undefined

/** The region's size: as laid out, or what the pane asked for before the first layout. */
export function size(props: BoardProps, s: { rows: number; columns: number }): { rows: number; columns: number } {
  return {
    // The desktop can report fewer rows than the region was given: never show fewer cards than asked for.
    rows: Math.max(s.rows, props.rows ?? 12),
    columns: s.columns >= 8 * Math.max(1, props.cols.length) ? s.columns : (props.columns ?? 100),
  }
}

export function colWidth(columns: number, n: number): number {
  return Math.max(8, Math.floor(columns / Math.max(1, n)))
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
  const z = size(latest, s)
  const at = hit(latest, z.columns, z.rows, ev.x, ev.y)
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
  const z = size(props, surface)
  const w = colWidth(z.columns, n)
  // One cell between columns. No Box borders here: the desktop draws them over the text.
  const iw = Math.max(4, w - 1)
  const room = fit(z.rows)
  const drag = surface.state?.drag
  const over = drag === undefined ? undefined : hit(props, z.columns, z.rows, drag.x, drag.y)

  return (
    <Box flexDirection="row">
      {props.cols.map((col, ci) => {
        const isTarget = over !== undefined && over.col === ci && !(drag !== undefined && drag.fromCol === ci && over.idx === drag.fromIdx)
        const shown = col.cards.slice(0, room)
        const hidden = col.cards.length - shown.length
        const dropAt = isTarget ? over?.idx : undefined
        return (
          <Box key={col.key} flexDirection="column" width={w}>
            <Box key={`${col.key}-head`} flexDirection="row" width={iw} justifyContent="space-between">
              <Text bold color={col.tone} underline={dropAt === 0 && shown.length === 0} wrap="truncate-end">
                {`${col.name} `}
              </Text>
              <Text color="inverseText" backgroundColor={isTarget ? 'suggestion' : col.tone}>{` ${col.count} `}</Text>
            </Box>
            <Text color={isTarget ? 'suggestion' : col.tone} dimColor={!isTarget} wrap="truncate-end">
              {'─'.repeat(iw)}
            </Text>
            {shown.map((card, i) => {
              const dragging = drag?.id === card.id
              const stripe = card.selected ? '█' : '▌'
              return (
                <Box key={card.id} flexDirection="column" width={iw}>
                  <Box key={`${card.id}-face`} flexDirection="column" width={iw} hover={{ backgroundColor: 'inactive' }}>
                    <Box flexDirection="row" width={iw}>
                      <Text color={card.colour} dimColor={dragging}>{stripe}</Text>
                      <Text bold color={card.flagTone}>{card.flag === '' ? ' ' : card.flag}</Text>
                      <Text
                        bold={card.selected}
                        dimColor={dragging}
                        underline={dropAt === i}
                        color={dropAt === i ? 'suggestion' : undefined}
                        wrap="truncate-end"
                      >
                        {card.title}
                      </Text>
                    </Box>
                    <Box flexDirection="row" width={iw}>
                      <Text color={card.colour} dimColor={dragging}>{stripe}</Text>
                      <Text dimColor wrap="truncate-end">{` ${card.meta}`}</Text>
                    </Box>
                  </Box>
                  {dropAt === i + 1 ? (
                    <Text color="suggestion" wrap="truncate-end">{'─'.repeat(iw)}</Text>
                  ) : (
                    <Text> </Text>
                  )}
                </Box>
              )
            })}
            {hidden > 0 && <Text dimColor wrap="truncate-end">{` +${hidden} more`}</Text>}
            {shown.length === 0 && (
              <Text color={isTarget ? 'suggestion' : undefined} dimColor={!isTarget} italic wrap="truncate-end">
                {isTarget ? ' ▸ drop here' : ' empty'}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default Board
