// Shared looks: the colour each column and status is drawn in, and text bars.
import type { Column } from '../types'

/** Theme keys, so the board follows the person's theme. */
export const COLUMN_TONE: Record<Column, string> = {
  backlog: 'subtle',
  queued: 'suggestion',
  running: 'claude',
  review: 'warning',
  done: 'success',
}

/** The colour a card's flag (from cardFlag) is drawn in. */
export function flagTone(flag: string): string {
  if (flag === '!') return 'warning'
  if (flag === '×') return 'error'
  return 'subtle'
}

/** A text progress bar, `███░░░`, `width` cells wide. */
export function textBar(done: number, total: number, width: number): string {
  const w = Math.max(1, width)
  const filled = total <= 0 ? 0 : Math.round((Math.min(done, total) / total) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

/** The same bar as SVG for surfaces that draw it (no theme keys inside SVG, so fixed colours). */
export function svgBar(done: number, total: number, width = 240, height = 8): string {
  const frac = total <= 0 ? 0 : Math.min(done, total) / total
  const r = height / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="#8a8a8a" fill-opacity="0.25"/>` +
    (frac > 0 ? `<rect width="${Math.max(height, Math.round(width * frac))}" height="${height}" rx="${r}" fill="#d97757"/>` : '') +
    `</svg>`
  )
}
