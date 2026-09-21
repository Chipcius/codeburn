import type { DailyEntry } from '../lib/api'

// Local-date keys, matching how codeburn buckets a day (local midnight).
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() + n)
  return out
}

export type Forecast = {
  monthToDate: number
  projection: number
  weekAvg: number
  yesterday: number
  last7: number
  previousMonth: number | null
}

/// Port of computeForecast in mac/.../HeatmapSection.swift, so the Linux
/// popover and the macOS one show the same projection for the same history.
/// Projection is month-to-date spend per ELAPSED day times the days in the
/// month; "last 7" includes today.
export function computeForecast(days: readonly DailyEntry[], now: Date = new Date()): Forecast {
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const firstKey = dayKey(first)
  const monthToDate = days.filter(d => d.date >= firstKey).reduce((s, d) => s + d.cost, 0)
  const projection = (monthToDate / now.getDate()) * daysInMonth

  const weekStart = dayKey(addDays(now, -6))
  const last7 = days.filter(d => d.date >= weekStart).reduce((s, d) => s + d.cost, 0)

  const yKey = dayKey(addDays(now, -1))
  const yesterday = days.find(d => d.date === yKey)?.cost ?? 0

  const prevFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevLast = new Date(now.getFullYear(), now.getMonth(), 0)
  const prevDays = days.filter(d => d.date >= dayKey(prevFirst) && d.date <= dayKey(prevLast))
  const previousMonth = prevDays.length > 0 ? prevDays.reduce((s, d) => s + d.cost, 0) : null

  return { monthToDate, projection, weekAvg: last7 / 7, yesterday, last7, previousMonth }
}

export type HeatCell = { date: string; cost: number; calls: number; future: boolean; level: 0 | 1 | 2 | 3 | 4 }

/// Weeks as columns, Monday-first rows, ending with the week containing `now`.
/// Levels are quartiles of the ACTIVE days in range, so one enormous day does
/// not wash every other day out to the palest shade.
export function heatmapWeeks(days: readonly DailyEntry[], weeks: number, now: Date = new Date()): HeatCell[][] {
  const byDate = new Map(days.map(d => [d.date, d]))
  const mondayOffset = (now.getDay() + 6) % 7
  const start = addDays(now, -mondayOffset - (weeks - 1) * 7)
  const todayKey = dayKey(now)

  const cells: HeatCell[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const date = dayKey(addDays(start, i))
    const e = byDate.get(date)
    cells.push({ date, cost: e?.cost ?? 0, calls: e?.calls ?? 0, future: date > todayKey, level: 0 })
  }

  const active = cells.filter(c => !c.future && c.cost > 0).map(c => c.cost).sort((a, b) => a - b)
  // Index over n-1, not n: with few active days `floor(0.75 * n)` lands on the
  // maximum itself, so the busiest day could never exceed the top threshold and
  // reach the darkest shade.
  const q = (p: number) => active[Math.floor(p * Math.max(0, active.length - 1))] ?? 0
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)]
  for (const c of cells) {
    if (c.future || c.cost <= 0) continue
    c.level = c.cost <= q1 ? 1 : c.cost <= q2 ? 2 : c.cost <= q3 ? 3 : 4
  }

  const out: HeatCell[][] = []
  for (let w = 0; w < weeks; w++) out.push(cells.slice(w * 7, w * 7 + 7))
  return out
}

export type Stats = {
  activeDays: number
  total: number
  avgActive: number
  peak: { date: string; cost: number } | null
  streak: number
}

/// Consecutive active days ending today, or ending yesterday when today has no
/// activity yet — so the streak does not read 0 every morning before the first
/// session of the day.
export function computeStats(cells: readonly HeatCell[], now: Date = new Date()): Stats {
  const past = cells.filter(c => !c.future)
  const active = past.filter(c => c.cost > 0)
  const total = active.reduce((s, c) => s + c.cost, 0)
  const peak = active.reduce<HeatCell | null>((best, c) => (!best || c.cost > best.cost ? c : best), null)

  const byDate = new Map(past.map(c => [c.date, c.cost]))
  let cursor = (byDate.get(dayKey(now)) ?? 0) > 0 ? now : addDays(now, -1)
  let streak = 0
  while ((byDate.get(dayKey(cursor)) ?? 0) > 0) {
    streak++
    cursor = addDays(cursor, -1)
  }

  return {
    activeDays: active.length,
    total,
    avgActive: active.length ? total / active.length : 0,
    peak: peak ? { date: peak.date, cost: peak.cost } : null,
    streak,
  }
}
