// The optimize scan re-read every Claude transcript overlapping the period on
// every request. A resident process now keeps each scanned file, keyed by the
// file's identity and the range it was scanned for, and the recency flag is
// stamped afterwards so a hit is not pinned to the cutoff it was first read
// under. What matters here: a hit is served without touching the disk, a
// rewritten file misses, and the memo stays bounded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearScanFileMemo,
  evictScanFileMemo,
  scanFileMemoStats,
  scanJsonlFileMemoized,
} from '../src/optimize.js'

describe('optimize scan-file memo', () => {
  let dir: string

  // The identity the scanner passes: whatever the file says right now.
  const idOf = (file: string): { size: number; mtimeMs: number } => {
    const s = statSync(file)
    return { size: s.size, mtimeMs: s.mtimeMs }
  }
  // Two writes inside one filesystem timestamp tick would look unchanged, so
  // move the stamp explicitly rather than racing the clock.
  const bump = (file: string): void => {
    const next = new Date(statSync(file).mtimeMs + 1000)
    utimesSync(file, next, next)
  }

  const transcript = (ts: string): string => [
    JSON.stringify({ type: 'user', timestamp: ts, cwd: '/work/app', message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({
      type: 'assistant', timestamp: ts, message: {
        role: 'assistant', usage: { cache_creation_input_tokens: 10 },
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/app/a.ts' } }],
      },
    }),
  ].join('\n') + '\n'

  beforeEach(() => {
    clearScanFileMemo()
    dir = mkdtempSync(join(tmpdir(), 'codeburn-scan-memo-'))
  })
  afterEach(() => {
    clearScanFileMemo()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves a second scan of the same file without reading it again', async () => {
    const file = join(dir, 'a.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    const identity = idOf(file)
    const first = await scanJsonlFileMemoized(file, 'app', undefined, identity)
    rmSync(file)
    const second = await scanJsonlFileMemoized(file, 'app', undefined, identity)
    expect(first.calls).toHaveLength(1)
    expect(second).toBe(first)
    expect(scanFileMemoStats().entries).toBe(1)
  })

  it('keeps a separate result per range', async () => {
    const file = join(dir, 'b.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    const identity = idOf(file)
    const base = await scanJsonlFileMemoized(file, 'app', undefined, identity)
    const range = { start: new Date('2026-08-20T00:00:00.000Z'), end: new Date('2026-08-21T00:00:00.000Z') }
    expect(await scanJsonlFileMemoized(file, 'app', range, identity)).not.toBe(base)
    expect(scanFileMemoStats().entries).toBe(2)
  })

  // The point of the offset: a live transcript is appended to between requests
  // and must not cost its whole length again, while still reading exactly as a
  // full read of the grown file would.
  it('reads only the appended bytes and lands on the full-read result', async () => {
    const file = join(dir, 'append.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    appendFileSync(file, transcript('2026-08-21T11:00:00.000Z'))
    bump(file)
    const resumed = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))

    clearScanFileMemo()
    const full = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(full))
    expect(resumed.calls).toHaveLength(2)
  })

  it('never consumes a line a writer has not finished', async () => {
    const file = join(dir, 'partial.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    // A half-written line, then the rest of it plus a complete one.
    const tail = transcript('2026-08-21T11:00:00.000Z')
    const split = Math.floor(tail.length / 2)
    appendFileSync(file, tail.slice(0, split))
    bump(file)
    const mid = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    appendFileSync(file, tail.slice(split))
    bump(file)
    const done = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))

    clearScanFileMemo()
    const full = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    expect(mid.calls.length).toBeLessThanOrEqual(2)
    expect(JSON.stringify(done)).toBe(JSON.stringify(full))
  })

  it('falls back to a full read when the file shrank', async () => {
    const file = join(dir, 'truncated.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z') + transcript('2026-08-21T11:00:00.000Z'))
    const first = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    expect(first.calls).toHaveLength(2)
    writeFileSync(file, transcript('2026-08-22T12:00:00.000Z'))
    bump(file)
    const after = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    expect(after.calls).toHaveLength(1)
  })

  it('falls back to a full read when the opening bytes changed', async () => {
    const file = join(dir, 'rewritten.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    // Grows, so size alone reads as an append, but it is a different file.
    writeFileSync(file, transcript('2026-08-22T12:00:00.000Z') + transcript('2026-08-23T13:00:00.000Z'))
    bump(file)
    const after = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))

    clearScanFileMemo()
    const full = await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    expect(after.calls).toHaveLength(2)
    expect(JSON.stringify(after)).toBe(JSON.stringify(full))
  })

  it('an unstattable file is scanned every time rather than memoized', async () => {
    const file = join(dir, 'c.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    const first = await scanJsonlFileMemoized(file, 'app', undefined, null)
    const second = await scanJsonlFileMemoized(file, 'app', undefined, null)
    expect(second).not.toBe(first)
    expect(scanFileMemoStats().entries).toBe(0)
  })

  it('drops entries past the age bound', async () => {
    const file = join(dir, 'd.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    await scanJsonlFileMemoized(file, 'app', undefined, idOf(file))
    expect(scanFileMemoStats().entries).toBe(1)
    evictScanFileMemo(Date.now() + 11 * 60 * 1000)
    expect(scanFileMemoStats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('evicts least recently used first when over the byte budget', async () => {
    const older = join(dir, 'e.jsonl')
    const newer = join(dir, 'f.jsonl')
    writeFileSync(older, transcript('2026-08-20T10:00:00.000Z'))
    writeFileSync(newer, transcript('2026-08-21T10:00:00.000Z'))
    const olderId = idOf(older)
    const kept = await scanJsonlFileMemoized(older, 'app', undefined, olderId)
    await scanJsonlFileMemoized(newer, 'app', undefined, idOf(newer))
    await new Promise(resolve => setTimeout(resolve, 5))
    await scanJsonlFileMemoized(older, 'app', undefined, olderId)
    evictScanFileMemo(Date.now(), scanFileMemoStats().bytes - 1)
    expect(scanFileMemoStats().entries).toBe(1)
    rmSync(older)
    expect(await scanJsonlFileMemoized(older, 'app', undefined, olderId)).toBe(kept)
  })
})
