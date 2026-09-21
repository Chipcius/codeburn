import { describe, expect, it } from 'vitest'

import { computeForecast, computeStats, dayKey, heatmapWeeks } from '../dash/src/popover/insights.js'
import type { DailyEntry } from '../dash/src/lib/api.js'

function day(date: string, cost: number, calls = 1): DailyEntry {
  return { date, cost, calls, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [] }
}

// Wednesday 2026-09-16, noon local.
const NOW = new Date(2026, 8, 16, 12)

describe('forecast (port of the macOS computeForecast)', () => {
  it('projects month-to-date spend per ELAPSED day across the whole month', () => {
    // 16 days elapsed in a 30-day month; $160 so far -> $10/day -> $300.
    const f = computeForecast([day('2026-09-01', 100), day('2026-09-16', 60), day('2026-08-31', 999)], NOW)
    expect(f.monthToDate).toBe(160)
    expect(f.projection).toBeCloseTo(300, 10)
  })

  it('counts "last 7" as 7 calendar days including today', () => {
    const days = [day('2026-09-09', 1000), day('2026-09-10', 7), day('2026-09-16', 3)]
    const f = computeForecast(days, NOW)
    // 09-10 .. 09-16 is the window; 09-09 is the 8th day back and excluded.
    expect(f.last7).toBe(10)
    expect(f.weekAvg).toBeCloseTo(10 / 7, 10)
  })

  it('reads yesterday by local date', () => {
    expect(computeForecast([day('2026-09-15', 42)], NOW).yesterday).toBe(42)
  })

  it('totals the previous calendar month, and reports none when there is no data', () => {
    expect(computeForecast([day('2026-08-01', 5), day('2026-08-31', 6), day('2026-07-31', 99)], NOW).previousMonth).toBe(11)
    expect(computeForecast([day('2026-09-01', 5)], NOW).previousMonth).toBeNull()
  })
})

describe('heatmap', () => {
  it('lays out Monday-first weeks ending with the current week', () => {
    const weeks = heatmapWeeks([], 3, NOW)
    expect(weeks).toHaveLength(3)
    expect(weeks.every(w => w.length === 7)).toBe(true)
    expect(weeks[2]![0]!.date).toBe('2026-09-14') // the Monday of this week
    expect(weeks[2]![2]!.date).toBe('2026-09-16') // today
  })

  it('marks days after today as future and leaves them unshaded', () => {
    const week = heatmapWeeks([day('2026-09-18', 50)], 1, NOW)[0]!
    const fri = week.find(c => c.date === '2026-09-18')!
    expect(fri.future).toBe(true)
    expect(fri.level).toBe(0)
  })

  it('shades by quartile of ACTIVE days, so one outlier does not wash out the rest', () => {
    const days = [
      day('2026-09-14', 1), day('2026-09-15', 2), day('2026-09-16', 1000),
    ]
    const cells = heatmapWeeks(days, 1, NOW)[0]!
    const level = (d: string) => cells.find(c => c.date === d)!.level
    // The busiest day reaches the darkest shade; with few active days the top
    // threshold used to land on the maximum itself, capping it at level 3.
    expect(level('2026-09-16')).toBe(4)
    expect(level('2026-09-14')).toBe(1)
    expect(level('2026-09-15')).toBe(2)
  })
})

describe('stats', () => {
  it('finds the peak day and the average over active days only', () => {
    const cells = heatmapWeeks([day('2026-09-14', 10), day('2026-09-16', 30)], 1, NOW).flat()
    const s = computeStats(cells, NOW)
    expect(s.activeDays).toBe(2)
    expect(s.avgActive).toBe(20)
    expect(s.peak).toEqual({ date: '2026-09-16', cost: 30 })
  })

  it('counts a streak ending today', () => {
    const cells = heatmapWeeks([day('2026-09-14', 1), day('2026-09-15', 1), day('2026-09-16', 1)], 1, NOW).flat()
    expect(computeStats(cells, NOW).streak).toBe(3)
  })

  it('keeps the streak alive from yesterday before today has any usage', () => {
    // Every morning would otherwise read "0d" until the first session.
    const cells = heatmapWeeks([day('2026-09-14', 1), day('2026-09-15', 1)], 1, NOW).flat()
    expect(computeStats(cells, NOW).streak).toBe(2)
  })

  it('uses local dates for the day key', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
