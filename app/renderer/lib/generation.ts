import type { MenubarPayload, Period } from './types'

export type PeriodTotals = NonNullable<MenubarPayload['periodTotals']>
export type Generation = { at: number; totals: PeriodTotals }

/// Windows that nest, narrowest first. `month` is a calendar window rather than
/// a suffix of history, so it is not comparable with the rest.
const NESTED: Array<keyof PeriodTotals> = ['today', 'week', '30days', 'all', 'lifetime']

/** Each window contains the one before it, so its totals cannot be smaller.
 *  Returns the first pair that breaks, or null. */
export function periodTotalsBreach(totals: PeriodTotals): string | null {
  for (let index = 1; index < NESTED.length; index++) {
    const narrow = totals[NESTED[index - 1]]
    const wide = totals[NESTED[index]]
    if (!narrow || !wide) continue
    // A cent of float drift across two sums is not a breach.
    if (wide.cost + 0.005 < narrow.cost) return `${NESTED[index]} cost ${wide.cost} < ${NESTED[index - 1]} ${narrow.cost}`
    if (wide.calls < narrow.calls) return `${NESTED[index]} calls ${wide.calls} < ${NESTED[index - 1]} ${narrow.calls}`
  }
  return null
}

/**
 * The newest generation the app has been handed.
 *
 * Every period's headline is read from one aggregation pass, so switching
 * period cannot mix two snapshots taken minutes apart — which is how the same
 * six months read $20,770.90 on one refresh and $37,683.63 on the next, and how
 * Lifetime came back smaller than the six months it contains.
 */
let current: Generation | null = null

export function rememberGeneration(payload: MenubarPayload | null | undefined, at: number | null): Generation | null {
  const totals = payload?.periodTotals
  if (totals && at != null && (current === null || at > current.at)) {
    if (import.meta.env?.DEV) {
      const breach = periodTotalsBreach(totals)
      if (breach) console.error(`codeburn: period totals are not nested: ${breach}`)
    }
    current = { at, totals }
  }
  return current
}

/** Cost and calls for `period` from the newest generation, or null when the CLI
 *  did not supply them (a scoped or filtered request, or an older CLI). */
export function generationHeadline(period: Period): { cost: number; calls: number } | null {
  return current?.totals[period as keyof PeriodTotals] ?? null
}

export function generationAt(): number | null {
  return current?.at ?? null
}

/** Test-only: drop the held generation between renders. */
export function __resetGeneration(): void {
  current = null
}
