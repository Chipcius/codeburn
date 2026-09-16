import { describe, expect, it } from 'vitest'

import { periodTotalsBreach, type PeriodTotals } from '../src/usage-aggregator.js'

function totals(over: Partial<Record<keyof PeriodTotals, [number, number]>> = {}): PeriodTotals {
  const base: Record<string, [number, number]> = {
    today: [706.23, 6119],
    week: [1903.71, 15475],
    '30days': [14376.43, 87639],
    month: [4735.43, 29024],
    all: [37765.72, 270029],
    lifetime: [37806.47, 272225],
    ...over,
  }
  return Object.fromEntries(Object.entries(base).map(([k, [cost, calls]]) => [k, { cost, calls }])) as PeriodTotals
}

describe('periodTotalsBreach', () => {
  it('accepts a generation whose windows nest', () => {
    expect(periodTotalsBreach(totals())).toBeNull()
  })

  it('catches lifetime costing less than the six months it contains', () => {
    expect(periodTotalsBreach(totals({ lifetime: [20774.51, 272225] }))).toMatch(/lifetime cost/)
  })

  it('catches calls going backwards between windows', () => {
    expect(periodTotalsBreach(totals({ lifetime: [37806.47, 269641] }))).toMatch(/lifetime calls/)
  })

  it('ignores month, which is a calendar window rather than a suffix of history', () => {
    expect(periodTotalsBreach(totals({ month: [0, 0] }))).toBeNull()
  })

  it('tolerates a cent of float drift between two sums', () => {
    expect(periodTotalsBreach(totals({ all: [37806.474, 272225], lifetime: [37806.47, 272225] }))).toBeNull()
  })
})
