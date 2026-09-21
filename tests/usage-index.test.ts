import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  USAGE_INDEX_SCHEMA_VERSION,
  dayTotals,
  deleteSourceRows,
  groupTotals,
  insertCalls,
  insertSessions,
  openUsageIndex,
  recordSource,
  selectChangedSources,
  usageIndexPath,
  type CallRecord,
  type SessionRecord,
  type UsageIndex,
} from '../src/usage-index.js'

// The index exists so a question about one day costs one day of reading. The
// blob caches it replaces could not do that: the September opencode shard is
// 1.6 MB, yet answering `--period today` deserialized the 143 MB March shard
// too and took ~38s. These tests pin the properties that buy that back —
// narrowing by day, replacing a re-ingested source instead of doubling it, and
// skipping a source whose bytes have not moved.

let dir: string
let index: UsageIndex
let saved: string | undefined

beforeEach(async () => {
  saved = process.env['CODEBURN_CACHE_DIR']
  dir = await mkdtemp(join(tmpdir(), 'codeburn-index-'))
  process.env['CODEBURN_CACHE_DIR'] = dir
  index = openUsageIndex()
})

afterEach(async () => {
  index.close()
  if (saved === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = saved
  await rm(dir, { recursive: true, force: true })
})

function session(uid: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    uid,
    provider: 'claude',
    sessionId: uid,
    sourcePath: `/src/${uid}.jsonl`,
    projectPath: '/work/alpha',
    projectLabel: 'alpha',
    firstTs: '2026-09-13T10:00:00.000Z',
    lastTs: '2026-09-13T11:00:00.000Z',
    ...extra,
  }
}

function call(uid: string, day: string, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    uid,
    sessionUid: 's1',
    provider: 'claude',
    model: 'claude-opus-5',
    day,
    ts: `${day}T10:00:00.000Z`,
    category: 'coding',
    speed: 'standard',
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 1000,
    cacheWriteTokens: 50,
    cacheWrite1h: 0,
    webSearches: 0,
    costUSD: 1.5,
    savingsUSD: 0,
    ...extra,
  }
}

describe('usage index schema', () => {
  it('creates the schema and stamps its version', () => {
    const rows = index.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])
    expect(rows[0]?.value).toBe(String(USAGE_INDEX_SCHEMA_VERSION))
  })

  it('lives under the configured cache dir, so a test never touches the real one', () => {
    expect(usageIndexPath().startsWith(dir)).toBe(true)
  })

  it('reopens an existing index without dropping its rows', () => {
    insertSessions(index, [session('s1')])
    insertCalls(index, [call('c1', '2026-09-13')])
    index.close()
    index = openUsageIndex()
    expect(index.query('SELECT uid FROM call')).toHaveLength(1)
  })
})

describe('incremental ingest watermark', () => {
  const state = { path: '/src/a.jsonl', mtimeMs: 1000, sizeBytes: 500 }

  it('reports an unseen source as changed', () => {
    expect(selectChangedSources(index, [state]).map(s => s.path)).toEqual(['/src/a.jsonl'])
  })

  it('skips a source whose mtime and size are both unchanged', () => {
    recordSource(index, { ...state, provider: 'claude' })
    expect(selectChangedSources(index, [state])).toEqual([])
  })

  it('re-reads a source that grew, even at the same mtime', () => {
    recordSource(index, { ...state, provider: 'claude' })
    expect(selectChangedSources(index, [{ ...state, sizeBytes: 900 }])).toHaveLength(1)
  })

  it('always retries a source recorded as partial', () => {
    recordSource(index, { ...state, provider: 'claude', status: 'partial' })
    expect(selectChangedSources(index, [state])).toHaveLength(1)
  })
})

describe('re-ingesting a source replaces its rows', () => {
  it('does not double a source parsed twice', () => {
    insertSessions(index, [session('s1')])
    insertCalls(index, [call('c1', '2026-09-13'), call('c2', '2026-09-13')])
    expect(dayTotals(index, '2026-09-13', '2026-09-13')[0]?.calls).toBe(2)

    // Second pass over the same file: drop what it contributed, then re-add.
    deleteSourceRows(index, '/src/s1.jsonl')
    expect(index.query('SELECT uid FROM call')).toHaveLength(0)
    insertSessions(index, [session('s1')])
    insertCalls(index, [call('c1', '2026-09-13'), call('c2', '2026-09-13')])
    expect(dayTotals(index, '2026-09-13', '2026-09-13')[0]?.calls).toBe(2)
  })

  it('leaves another source untouched when one is replaced', () => {
    insertSessions(index, [session('s1'), session('s2', { sourcePath: '/src/s2.jsonl' })])
    insertCalls(index, [call('c1', '2026-09-13'), call('c2', '2026-09-13', { sessionUid: 's2' })])
    deleteSourceRows(index, '/src/s1.jsonl')
    expect(index.query('SELECT uid FROM call')).toHaveLength(1)
  })
})

describe('reads are narrowed by day', () => {
  beforeEach(() => {
    insertSessions(index, [session('s1'), session('s2', { provider: 'codex', projectLabel: 'beta', projectPath: '/work/beta', sourcePath: '/src/s2.jsonl' })])
    insertCalls(index, [
      call('c1', '2026-09-12'),
      call('c2', '2026-09-13'),
      call('c3', '2026-09-13', { costUSD: 2.5 }),
      call('c4', '2026-09-14', { sessionUid: 's2', provider: 'codex', model: 'gpt-6-astra', costUSD: 10 }),
    ])
  })

  it('returns only the days asked for', () => {
    const rows = dayTotals(index, '2026-09-13', '2026-09-13')
    expect(rows.map(r => r.day)).toEqual(['2026-09-13'])
    expect(rows[0]!.calls).toBe(2)
    expect(rows[0]!.cost).toBeCloseTo(4, 10)
  })

  it('sums a multi-day window per day, in order', () => {
    const rows = dayTotals(index, '2026-09-12', '2026-09-14')
    expect(rows.map(r => r.day)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14'])
    expect(rows.map(r => Math.round(r.cost * 100) / 100)).toEqual([1.5, 4, 10])
  })

  it('carries the token columns through', () => {
    const row = dayTotals(index, '2026-09-13', '2026-09-13')[0]!
    expect(row.cacheReadTokens).toBe(2000)
    expect(row.cacheWriteTokens).toBe(100)
    expect(row.inputTokens).toBe(200)
  })

  it('narrows by provider when asked', () => {
    expect(dayTotals(index, '2026-09-12', '2026-09-14', 'codex').map(r => r.day)).toEqual(['2026-09-14'])
    expect(dayTotals(index, '2026-09-12', '2026-09-14', 'all')).toHaveLength(3)
  })

  it('returns nothing for a window with no calls, rather than everything', () => {
    expect(dayTotals(index, '2025-01-01', '2025-01-31')).toEqual([])
  })
})

describe('breakdowns come from the index', () => {
  beforeEach(() => {
    insertSessions(index, [session('s1'), session('s2', { provider: 'codex', projectLabel: 'beta', projectPath: '/work/beta', sourcePath: '/src/s2.jsonl' })])
    insertCalls(index, [
      call('c1', '2026-09-13'),
      call('c2', '2026-09-13', { sessionUid: 's2', provider: 'codex', model: 'gpt-6-astra', costUSD: 10 }),
    ])
  })

  it('groups by provider, most expensive first', () => {
    expect(groupTotals(index, 'provider', '2026-09-13', '2026-09-13').map(r => [r.key, r.cost]))
      .toEqual([['codex', 10], ['claude', 1.5]])
  })

  it('groups by model', () => {
    expect(groupTotals(index, 'model', '2026-09-13', '2026-09-13').map(r => r.key))
      .toEqual(['gpt-6-astra', 'claude-opus-5'])
  })

  it('groups by project across the session join', () => {
    expect(groupTotals(index, 'project', '2026-09-13', '2026-09-13').map(r => [r.key, r.calls]))
      .toEqual([['beta', 1], ['alpha', 1]])
  })

  it('respects the day window in a breakdown too', () => {
    expect(groupTotals(index, 'provider', '2026-09-14', '2026-09-14')).toEqual([])
  })
})

describe('transactions', () => {
  it('rolls back a failed batch so a crashed ingest leaves no half-session', () => {
    insertSessions(index, [session('s1')])
    expect(() => index.transaction(() => {
      insertCalls(index, [call('c1', '2026-09-13')])
      throw new Error('parser blew up mid-session')
    })).toThrow('parser blew up mid-session')
    expect(index.query('SELECT uid FROM call')).toHaveLength(0)
  })

  it('commits a batch that succeeds', () => {
    insertSessions(index, [session('s1')])
    index.transaction(() => insertCalls(index, [call('c1', '2026-09-13'), call('c2', '2026-09-13')]))
    expect(index.query('SELECT uid FROM call')).toHaveLength(2)
  })
})
