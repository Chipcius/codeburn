/** Sparkline geometry, kept out of the component so the maths is testable. */

export type SparkPoint = [number, number]

/** Maps a series onto a `width` x `height` box, newest last, `inset` px clear of the top and bottom. */
export function sparkPoints(values: number[], width: number, height: number, inset = 3): SparkPoint[] {
  if (!values.length) return []
  const max = Math.max(...values, 0)
  const span = Math.max(1, values.length - 1)
  const usable = Math.max(0, height - inset * 2)
  return values.map((value, index) => [
    (index / span) * width,
    height - inset - (max > 0 ? Math.max(0, value) / max : 0) * usable,
  ])
}

/** A smooth curve: each segment is a cubic whose handles sit on the segment's horizontal midpoint. */
export function sparkPath(points: SparkPoint[]): string {
  if (!points.length) return ''
  let d = `M${points[0][0]} ${points[0][1]}`
  for (let index = 1; index < points.length; index++) {
    const [x0, y0] = points[index - 1]
    const [x1, y1] = points[index]
    const mid = (x0 + x1) / 2
    d += ` C${mid} ${y0} ${mid} ${y1} ${x1} ${y1}`
  }
  return d
}

/** The same curve closed down to the baseline, for the gradient fill. */
export function sparkArea(points: SparkPoint[], height: number): string {
  if (points.length < 2) return ''
  const last = points[points.length - 1]
  return `${sparkPath(points)} L${last[0]} ${height} L${points[0][0]} ${height} Z`
}

/** Spend under its comparison is the good direction, so a negative delta is green. */
export function paceDirection(delta: number): 'good' | 'bad' {
  return delta < 0 ? 'good' : 'bad'
}
