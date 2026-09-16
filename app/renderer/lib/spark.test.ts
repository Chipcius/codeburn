import { describe, expect, it } from 'vitest'

import { paceDirection, sparkArea, sparkPath, sparkPoints } from './spark'

describe('sparkPoints', () => {
  it('spreads the series across the width and puts the peak at the top inset', () => {
    expect(sparkPoints([0, 5, 10], 100, 40, 3)).toEqual([
      [0, 37],
      [50, 20],
      [100, 3],
    ])
  })

  it('draws a flat all-zero series on the baseline instead of dividing by zero', () => {
    expect(sparkPoints([0, 0, 0], 100, 40, 3)).toEqual([[0, 37], [50, 37], [100, 37]])
  })

  it('places a single point at the left edge', () => {
    expect(sparkPoints([7], 100, 40, 3)).toEqual([[0, 3]])
  })

  it('returns nothing for an empty series', () => {
    expect(sparkPoints([], 100, 40)).toEqual([])
  })
})

describe('sparkPath', () => {
  it('joins points with cubics whose handles sit on the segment midpoint', () => {
    expect(sparkPath([[0, 10], [10, 0]])).toBe('M0 10 C5 10 5 0 10 0')
  })

  it('is empty for an empty series', () => {
    expect(sparkPath([])).toBe('')
  })
})

describe('sparkArea', () => {
  it('closes the curve down to the baseline', () => {
    expect(sparkArea([[0, 10], [10, 0]], 40)).toBe('M0 10 C5 10 5 0 10 0 L10 40 L0 40 Z')
  })

  it('needs two points to enclose anything', () => {
    expect(sparkArea([[0, 10]], 40)).toBe('')
  })
})

describe('paceDirection', () => {
  it('reads spending under the comparison as good', () => {
    expect(paceDirection(-30)).toBe('good')
  })

  it('reads spending over the comparison as bad', () => {
    expect(paceDirection(12)).toBe('bad')
  })

  it('treats dead level as bad, not good: it is not under the comparison', () => {
    expect(paceDirection(0)).toBe('bad')
  })
})
