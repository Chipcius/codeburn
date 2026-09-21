import { describe, expect, it } from 'vitest'

import { planWatches } from '../src/usage-index-watch.js'

// Recursive fs.watch on Linux costs one inotify watch per directory, from a
// per-user budget (65,536 here) shared with every editor and dev server. A real
// OpenCode store measured 65,513 directories, so watching it recursively would
// take nearly the whole budget and break file watching for everything else.
describe('watch budgeting', () => {
  const limits = { perRoot: 5_000, total: 20_000 }

  it('watches small roots recursively', () => {
    expect(planWatches([
      { root: '/claude', dirs: 660 },
      { root: '/codex', dirs: 43 },
    ], limits).every(p => p.recursive)).toBe(true)
  })

  it('watches a root over the per-root limit at its top level only', () => {
    const plan = planWatches([{ root: '/opencode', dirs: 65_513 }], limits)
    expect(plan[0]).toMatchObject({ root: '/opencode', recursive: false })
  })

  it('never lets one huge root spend the budget the small ones need', () => {
    const plan = planWatches([
      { root: '/opencode', dirs: 65_513 },
      { root: '/claude', dirs: 660 },
      { root: '/codex', dirs: 43 },
    ], limits)
    const byRoot = Object.fromEntries(plan.map(p => [p.root, p.recursive]))
    expect(byRoot).toEqual({ '/opencode': false, '/claude': true, '/codex': true })
  })

  it('stops going recursive once the total budget would be exceeded', () => {
    const plan = planWatches([
      { root: '/a', dirs: 4_000 },
      { root: '/b', dirs: 4_000 },
      { root: '/c', dirs: 4_000 },
    ], { perRoot: 5_000, total: 9_000 })
    // Two fit (8,000); the third would take it to 12,000.
    expect(plan.filter(p => p.recursive)).toHaveLength(2)
  })

  it('treats a root exactly at the per-root limit as small enough', () => {
    expect(planWatches([{ root: '/edge', dirs: 5_000 }], limits)[0]!.recursive).toBe(true)
  })
})
