// The optimize scan re-read every Claude transcript overlapping the period on
// every request. A resident process now keeps each scanned file, keyed by the
// file's identity and the range it was scanned for, and the recency flag is
// stamped afterwards so a hit is not pinned to the cutoff it was first read
// under. What matters here: a hit is served without touching the disk, a
// rewritten file misses, and the memo stays bounded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
    const first = await scanJsonlFileMemoized(file, 'app', undefined, '1:1')
    rmSync(file)
    const second = await scanJsonlFileMemoized(file, 'app', undefined, '1:1')
    expect(first.calls).toHaveLength(1)
    expect(second).toBe(first)
    expect(scanFileMemoStats().entries).toBe(1)
  })

  it('misses when the file identity or the range changes', async () => {
    const file = join(dir, 'b.jsonl')
    writeFileSync(file, transcript('2026-08-20T10:00:00.000Z'))
    const base = await scanJsonlFileMemoized(file, 'app', undefined, '1:1')
    expect(await scanJsonlFileMemoized(file, 'app', undefined, '2:2')).not.toBe(base)
    const range = { start: new Date('2026-08-20T00:00:00.000Z'), end: new Date('2026-08-21T00:00:00.000Z') }
    expect(await scanJsonlFileMemoized(file, 'app', range, '1:1')).not.toBe(base)
    expect(scanFileMemoStats().entries).toBe(3)
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
    await scanJsonlFileMemoized(file, 'app', undefined, '1:1')
    expect(scanFileMemoStats().entries).toBe(1)
    evictScanFileMemo(Date.now() + 11 * 60 * 1000)
    expect(scanFileMemoStats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('evicts least recently used first when over the byte budget', async () => {
    const older = join(dir, 'e.jsonl')
    const newer = join(dir, 'f.jsonl')
    writeFileSync(older, transcript('2026-08-20T10:00:00.000Z'))
    writeFileSync(newer, transcript('2026-08-21T10:00:00.000Z'))
    const kept = await scanJsonlFileMemoized(older, 'app', undefined, '1:1')
    await scanJsonlFileMemoized(newer, 'app', undefined, '2:2')
    await new Promise(resolve => setTimeout(resolve, 5))
    await scanJsonlFileMemoized(older, 'app', undefined, '1:1')
    evictScanFileMemo(Date.now(), scanFileMemoStats().bytes - 1)
    expect(scanFileMemoStats().entries).toBe(1)
    rmSync(older)
    expect(await scanJsonlFileMemoized(older, 'app', undefined, '1:1')).toBe(kept)
  })
})
