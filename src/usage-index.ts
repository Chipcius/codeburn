import { mkdirSync } from 'fs'
import { join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import { loadSqliteConstructor } from './sqlite.js'

/// codeburn's OWN compiled dataset. Everything else under the cache dir is a
/// whole-file JSON blob, which is why a question about one day costs hundreds of
/// megabytes of deserialization: the September opencode shard is 1.6 MB, but a
/// `--period today` read pulls the 143 MB March shard alongside it and spends ~38
/// seconds doing it. A blob cannot be read in part, cannot be indexed, and cannot
/// be written by one process while another reads it.
///
/// So the read path moves off the blobs entirely. Providers' own stores are
/// WATCHED AND INGESTED, never queried to answer a UI request; the UIs query
/// this index and nothing else. Design consequences:
///
///   - Embedded, not a server. This is a local CLI; a Postgres dependency would
///     be a daemon to install, secure and keep running for a `codeburn status`.
///     The compiled data is also far smaller than the raw stores it summarizes
///     (aggregates and per-call rows, not 26 GB of transcripts).
///   - WAL, so a background ingest can write while a dashboard reads. This is the
///     property the blob design could never have, and the reason ingestion can
///     move off the read path at all.
///   - `day` is stored as a local-date string, matching how every existing
///     surface buckets a day (local midnight). Storing UTC instants and grouping
///     later would silently re-bucket every row for anyone not on UTC.
///   - Ingestion is incremental against a per-source watermark, so re-ingesting
///     an unchanged corpus is a stat sweep rather than a parse.

export const USAGE_INDEX_SCHEMA_VERSION = 6

export type SqliteValue = string | number | bigint | null | Uint8Array
type Row = Record<string, SqliteValue>

type StatementHandle = {
  all(...params: SqliteValue[]): unknown[]
  run(...params: SqliteValue[]): unknown
}
type WritableDatabase = {
  exec(sql: string): void
  prepare(sql: string): StatementHandle
  close(): void
}
type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => WritableDatabase

export type UsageIndex = {
  /// Rows for a read-only question. Never used to answer a UI request from a
  /// provider's own store — that is what ingestion is for.
  query<T extends Row = Row>(sql: string, params?: SqliteValue[]): T[]
  run(sql: string, params?: SqliteValue[]): void
  /// Like run, but reports how many rows changed — so an INSERT ... ON CONFLICT
  /// DO NOTHING can tell a new row from a duplicate it silently skipped.
  runChanges(sql: string, params: SqliteValue[]): number
  /// One transaction. Ingesting a session's calls row-by-row without this is
  /// one fsync per row, which is slower than the blob write it replaces.
  transaction<T>(fn: () => T): T
  close(): void
  path: string
}

export function usageIndexPath(): string {
  return join(getCodeburnCacheDir(), `usage-index.v${USAGE_INDEX_SCHEMA_VERSION}.db`)
}

// `day` carries a local-date string and every range predicate is a string
// compare, so it must be zero-padded to sort correctly.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- One row per ingested source file (a transcript, a rollout, a provider DB).
-- The watermark: a source whose size and mtime are unchanged is skipped without
-- opening it. 'partial' records a source that parsed incompletely, so a later
-- run retries it instead of trusting a short read forever.
CREATE TABLE IF NOT EXISTS source (
  path         TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,
  ingested_at  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'complete'
) STRICT;

CREATE TABLE IF NOT EXISTS session (
  uid           TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  source_path   TEXT,
  project_path  TEXT,
  project_label TEXT,
  first_ts      TEXT,
  last_ts       TEXT
) STRICT;

-- The fact table. One row per API call, which is the grain every surface
-- aggregates from: day totals, per-provider, per-model, per-project, per-session.
-- Costs are stored as computed at ingest so a read is a SUM, never a repricing.
CREATE TABLE IF NOT EXISTS call (
  uid                TEXT PRIMARY KEY,
  session_uid        TEXT NOT NULL,
  provider           TEXT NOT NULL,
  -- The raw provider id, kept because pricing, aliasing and tier lookup all key
  -- off it. It is NOT the grouping key: the daily cache and every report group by
  -- display name, so indexing on the raw id made a breakdown look like it had
  -- lost $8,912 of Opus 5 when the money was sitting under "claude-opus-5".
  model              TEXT NOT NULL,
  -- modelRowKey(): codeburn's canonical grouping key, route suffix and user
  -- aliases included. What every breakdown must group by.
  model_key          TEXT NOT NULL,
  -- The turn this call belongs to. Reports count TURNS per activity category,
  -- not calls (one turn is one user exchange and may make many calls), so the
  -- category panel is COUNT(DISTINCT turn_uid), which needs the turn's identity.
  turn_uid           TEXT NOT NULL,
  day                TEXT NOT NULL,
  ts                 TEXT,
  category           TEXT,
  speed              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h     INTEGER NOT NULL DEFAULT 0,
  web_searches       INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  savings_usd        REAL NOT NULL DEFAULT 0,
  -- 1 when cost_usd was priced from ESTIMATED tokens (the provider did not
  -- report real usage). Display-only: it never changes a total, but a report
  -- that drops it presents a guess as a measurement, which is what the "~"
  -- marker on a model row exists to prevent.
  estimated          INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Every UI question starts by narrowing to a date window, so day leads each
-- index; the trailing column lets the common breakdowns be answered from the
-- index alone rather than by visiting rows.
-- Day/provider totals the index CANNOT derive, because the sources are gone.
-- Claude Code deletes transcripts on a retention period, so the oldest history
-- exists only in the durable daily cache; on this corpus that is $11.5k across
-- 117 days. The index is built from sources, so those days must be carried in
-- from the cache rather than recomputed, exactly as the daily cache carries a
-- sourceless slice forward. Seeded only where the index has no calls for the
-- pair, so live data always wins and a carried row can never shadow it.
CREATE TABLE IF NOT EXISTS carried_day (
  day                TEXT NOT NULL,
  provider           TEXT NOT NULL,
  cost_usd           REAL NOT NULL DEFAULT 0,
  savings_usd        REAL NOT NULL DEFAULT 0,
  calls              INTEGER NOT NULL DEFAULT 0,
  sessions           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  models_json        TEXT,
  PRIMARY KEY (day, provider)
) STRICT;

CREATE INDEX IF NOT EXISTS carried_day_idx        ON carried_day (day);

-- Tool invocations, one row per tool use in a call. Carries day so a window
-- narrows here directly rather than joining back to call for every count.
CREATE TABLE IF NOT EXISTS call_tool (
  call_uid TEXT NOT NULL,
  day      TEXT NOT NULL,
  tool     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS call_tool_day_idx      ON call_tool (day, tool);
CREATE INDEX IF NOT EXISTS call_tool_call_idx     ON call_tool (call_uid);

-- Finished UI payloads, materialized by the worker after each ingest. The
-- dashboard payload leans on a dozen derived structures (tool, skill, subagent
-- and MCP rollups, retry tax, routing waste, the granular timeline) that are
-- all computed by codeburn's existing builder from a parsed corpus. Rather than
-- re-derive each over this index and drift from it, the worker - which already
-- holds the parse warm - runs that builder and stores the result. A UI read is
-- then a primary-key lookup, and matches the live path because it IS the live
-- path, run ahead of time.
CREATE TABLE IF NOT EXISTS ui_payload (
  key       TEXT PRIMARY KEY,
  json      TEXT NOT NULL,
  built_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS call_day_idx          ON call (day);
CREATE INDEX IF NOT EXISTS call_day_provider_idx ON call (day, provider);
CREATE INDEX IF NOT EXISTS call_day_model_idx    ON call (day, model_key);
CREATE INDEX IF NOT EXISTS call_session_idx      ON call (session_uid);
CREATE INDEX IF NOT EXISTS session_provider_idx  ON session (provider);
CREATE INDEX IF NOT EXISTS session_project_idx   ON session (project_path);
CREATE INDEX IF NOT EXISTS session_source_idx    ON session (source_path);
`

let DatabaseCtorCache: DatabaseCtor | null = null

function loadDatabaseCtor(): DatabaseCtor {
  if (DatabaseCtorCache) return DatabaseCtorCache
  DatabaseCtorCache = loadSqliteConstructor() as DatabaseCtor
  return DatabaseCtorCache
}

/// Open (creating if absent) and migrate. `readOnly` is for a UI process: it must
/// never be the thing that creates or migrates the index, so a reader opening a
/// missing index fails loudly rather than racing the ingester to build one.
export function openUsageIndex(opts: { readOnly?: boolean } = {}): UsageIndex {
  const Database = loadDatabaseCtor()
  const path = usageIndexPath()
  if (!opts.readOnly) mkdirSync(getCodeburnCacheDir(), { recursive: true })

  const db = new Database(path, opts.readOnly ? { readOnly: true } : {})
  // WAL lets the ingester write while readers read, which is the whole point of
  // moving ingestion off the read path. NORMAL trades an fsync per commit for
  // durability only against OS crash, not process crash — acceptable for a cache
  // that can always be rebuilt from the sources.
  if (!opts.readOnly) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')

  const index: UsageIndex = {
    path,
    query<T extends Row = Row>(sql: string, params: SqliteValue[] = []): T[] {
      return db.prepare(sql).all(...params) as T[]
    },
    run(sql: string, params: SqliteValue[] = []): void {
      // DDL and other parameterless statements go through exec: node:sqlite
      // finalizes a prepared DDL statement out from under itself ("statement has
      // been finalized"), and exec also accepts a multi-statement script.
      if (params.length === 0) db.exec(sql)
      else db.prepare(sql).run(...params)
    },
    runChanges(sql: string, params: SqliteValue[]): number {
      const result = db.prepare(sql).run(...params) as { changes?: number | bigint } | undefined
      return Number(result?.changes ?? 0)
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* the transaction is already gone; report the original failure */
        }
        throw err
      }
    },
    close(): void {
      db.close()
    },
  }

  if (!opts.readOnly) migrate(index)
  return index
}

function migrate(index: UsageIndex): void {
  index.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const found = index.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])
  const current = found.length > 0 ? Number(found[0]!.value) : 0
  if (current === USAGE_INDEX_SCHEMA_VERSION) return
  // No down-migration and no in-place upgrade yet: the index is derived data, so
  // a version change drops what it holds and re-ingests from the sources. The
  // durable daily cache remains the only store that must never lose history.
  if (current !== 0) {
    for (const table of ['ui_payload', 'call_tool', 'call', 'session', 'source', 'carried_day']) index.run(`DROP TABLE IF EXISTS ${table}`)
  }
  index.run(SCHEMA)
  index.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    'schema_version',
    String(USAGE_INDEX_SCHEMA_VERSION),
  ])
}

/// When the index last finished a full ingest, or null if it never has. A
/// reader uses this to decide whether to kick a background refresh and to tell
/// the user how old the figures are, instead of presenting stale data as live.
export function lastIngestAt(index: UsageIndex): number | null {
  const [row] = index.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['last_ingest_at'])
  const value = row ? Number(row.value) : NaN
  return Number.isFinite(value) ? value : null
}

export function markIngested(index: UsageIndex, at: number = Date.now()): void {
  index.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['last_ingest_at', String(at)],
  )
}

export function storePayload(index: UsageIndex, key: string, json: string, at: number = Date.now()): void {
  index.run(
    `INSERT INTO ui_payload (key, json, built_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET json = excluded.json, built_at = excluded.built_at`,
    [key, json, at],
  )
}

/// A materialized payload and when it was built, or null. The caller decides
/// whether it is fresh enough; a missing key means "not materialized", never
/// "no usage", so the caller must fall back rather than render nothing.
export function readPayload(index: UsageIndex, key: string): { json: string; builtAt: number } | null {
  const [row] = index.query<{ json: string; built_at: number }>('SELECT json, built_at FROM ui_payload WHERE key = ?', [key])
  return row ? { json: String(row.json), builtAt: Number(row.built_at) } : null
}

export type SourceState = { path: string; mtimeMs: number; sizeBytes: number }

/// Which of `sources` changed since their last ingest. Unchanged means same path,
/// same mtime AND same size, and a source last read only partially always counts
/// as changed so the retry it was promised actually happens.
export function selectChangedSources(index: UsageIndex, sources: readonly SourceState[]): SourceState[] {
  if (sources.length === 0) return []
  const known = new Map<string, { mtime_ms: number; size_bytes: number; status: string }>()
  for (const row of index.query<{ path: string; mtime_ms: number; size_bytes: number; status: string }>(
    'SELECT path, mtime_ms, size_bytes, status FROM source',
  )) {
    known.set(row.path, { mtime_ms: Number(row.mtime_ms), size_bytes: Number(row.size_bytes), status: row.status })
  }
  return sources.filter(s => {
    const prior = known.get(s.path)
    if (!prior || prior.status !== 'complete') return true
    return prior.mtime_ms !== s.mtimeMs || prior.size_bytes !== s.sizeBytes
  })
}

export function recordSource(
  index: UsageIndex,
  source: SourceState & { provider: string; status?: 'complete' | 'partial' },
): void {
  index.run(
    `INSERT INTO source (path, provider, mtime_ms, size_bytes, ingested_at, status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       provider = excluded.provider, mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes, ingested_at = excluded.ingested_at,
       status = excluded.status`,
    [source.path, source.provider, source.mtimeMs, source.sizeBytes, Date.now(), source.status ?? 'complete'],
  )
}

/// Drop everything a source contributed, so re-ingesting a changed file replaces
/// its rows instead of doubling them. Keyed on session.source_path rather than on
/// call rows directly, since a call only knows its session.
export function deleteSourceRows(index: UsageIndex, path: string): void {
  // Tool rows first: they hang off call uids, which the next statement removes.
  index.run(
    `DELETE FROM call_tool WHERE call_uid IN (
       SELECT c.uid FROM call c JOIN session s ON s.uid = c.session_uid WHERE s.source_path = ?
     )`,
    [path],
  )
  index.run('DELETE FROM call WHERE session_uid IN (SELECT uid FROM session WHERE source_path = ?)', [path])
  index.run('DELETE FROM session WHERE source_path = ?', [path])
}

export type SessionRecord = {
  uid: string
  provider: string
  sessionId: string
  sourcePath: string | null
  projectPath: string | null
  projectLabel: string | null
  firstTs: string | null
  lastTs: string | null
}

export type CallRecord = {
  uid: string
  sessionUid: string
  provider: string
  /// Raw provider id, for pricing and aliasing.
  model: string
  /// modelRowKey() — the key every breakdown groups by.
  modelKey: string
  /// Identity of the turn this call belongs to; category panels count turns.
  turnUid: string
  /// Tool names invoked in this call, one entry per use.
  tools: readonly string[]
  day: string
  ts: string | null
  category: string | null
  speed: string | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1h: number
  webSearches: number
  costUSD: number
  savingsUSD: number
  /// Priced from estimated tokens; drives the "~" marker, never a total.
  estimated: boolean
}

export function insertSessions(index: UsageIndex, sessions: readonly SessionRecord[]): void {
  for (const s of sessions) {
    index.run(
      `INSERT INTO session (uid, provider, session_id, source_path, project_path, project_label, first_ts, last_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         provider = excluded.provider, session_id = excluded.session_id,
         source_path = excluded.source_path, project_path = excluded.project_path,
         project_label = excluded.project_label, first_ts = excluded.first_ts,
         last_ts = excluded.last_ts`,
      [s.uid, s.provider, s.sessionId, s.sourcePath, s.projectPath, s.projectLabel, s.firstTs, s.lastTs],
    )
  }
}

export function insertCalls(index: UsageIndex, calls: readonly CallRecord[]): void {
  for (const c of calls) {
    // A call already present (the same API response seen in a resumed transcript
    // and its original) is skipped, and so must its tools be, or every duplicate
    // re-counts them.
    const inserted = index.runChanges(
      `INSERT INTO call (
         uid, session_uid, provider, model, model_key, turn_uid, day, ts, category, speed,
         input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
         cache_write_tokens, cache_write_1h, web_searches, cost_usd, savings_usd, estimated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO NOTHING`,
      [
        c.uid, c.sessionUid, c.provider, c.model, c.modelKey, c.turnUid, c.day, c.ts, c.category, c.speed,
        c.inputTokens, c.outputTokens, c.reasoningTokens, c.cacheReadTokens,
        c.cacheWriteTokens, c.cacheWrite1h, c.webSearches, c.costUSD, c.savingsUSD, c.estimated ? 1 : 0,
      ],
    )
    if (inserted === 0) continue
    for (const tool of c.tools) {
      index.run('INSERT INTO call_tool (call_uid, day, tool) VALUES (?, ?, ?)', [c.uid, c.day, tool])
    }
  }
}

export type DayTotals = {
  day: string
  /// Providers with any usage that day. Filled by the resolved read; the raw
  /// `dayTotals` groups by day only and leaves it unset.
  providers?: string[]
  cost: number
  savings: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/// Day totals over an inclusive local-date range. This is the query the whole
/// exercise exists for: it reads an index, not a corpus, so its cost scales with
/// the days asked for rather than with everything ever recorded.
export function dayTotals(index: UsageIndex, fromDay: string, toDay: string, provider?: string): DayTotals[] {
  const providerClause = provider && provider !== 'all' ? ' AND provider = ?' : ''
  const params: SqliteValue[] = [fromDay, toDay]
  if (providerClause) params.push(provider!)
  return index.query<Row>(
    `SELECT day,
            SUM(cost_usd)           AS cost,
            SUM(savings_usd)        AS savings,
            COUNT(*)                AS calls,
            SUM(input_tokens)       AS input_tokens,
            SUM(output_tokens)      AS output_tokens,
            SUM(cache_read_tokens)  AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens
       FROM call
      WHERE day BETWEEN ? AND ?${providerClause}
      GROUP BY day
      ORDER BY day`,
    params,
  ).map(r => ({
    day: String(r['day']),
    cost: Number(r['cost'] ?? 0),
    savings: Number(r['savings'] ?? 0),
    calls: Number(r['calls'] ?? 0),
    inputTokens: Number(r['input_tokens'] ?? 0),
    outputTokens: Number(r['output_tokens'] ?? 0),
    cacheReadTokens: Number(r['cache_read_tokens'] ?? 0),
    cacheWriteTokens: Number(r['cache_write_tokens'] ?? 0),
  }))
}

export type CarriedDayRow = {
  day: string
  provider: string
  cost: number
  savings: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  models?: Record<string, { cost: number; calls: number; tokens: number }>
}

/// Replace the carried set with the slices the cache explains BETTER than the
/// index can. Not just the ones the index lacks entirely: a day inside the source
/// retention window can survive only partly — a transcript deleted after the
/// cache recorded it leaves the sources explaining a fraction of the calls. On
/// this corpus that is 16 August/claude days worth $2,059 that a
/// "carry only what is missing" rule silently dropped.
///
/// The test is call count, matching `isPartialSurvival` in daily-cache.ts: more
/// calls means the better derivation, and ties go to the index because it is
/// per-call and can be re-priced. A carried slice REPLACES the derived one at
/// read time (see dayTotalsWithCarried), so this never double-counts.
export function seedCarriedDays(index: UsageIndex, rows: readonly CarriedDayRow[]): number {
  return index.transaction(() => {
    index.run('DELETE FROM carried_day')
    const derivedCalls = new Map<string, number>()
    for (const r of index.query<{ day: string; provider: string; calls: number }>(
      'SELECT day, provider, COUNT(*) AS calls FROM call GROUP BY day, provider',
    )) {
      derivedCalls.set(`${r.day}\u0000${r.provider}`, Number(r.calls))
    }
    let kept = 0
    for (const row of rows) {
      if (row.cost === 0 && row.calls === 0) continue
      if (row.calls <= (derivedCalls.get(`${row.day}\u0000${row.provider}`) ?? 0)) continue
      index.run(
        `INSERT INTO carried_day (
           day, provider, cost_usd, savings_usd, calls, sessions,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, models_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, provider) DO UPDATE SET
           cost_usd = excluded.cost_usd, savings_usd = excluded.savings_usd,
           calls = excluded.calls, sessions = excluded.sessions,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens,
           models_json = excluded.models_json`,
        [
          row.day, row.provider, row.cost, row.savings, Math.round(row.calls), Math.round(row.sessions),
          Math.round(row.inputTokens), Math.round(row.outputTokens),
          Math.round(row.cacheReadTokens), Math.round(row.cacheWriteTokens),
          row.models ? JSON.stringify(row.models) : null,
        ],
      )
      kept++
    }
    return kept
  })
}

/// Day totals, resolved per (day, provider): a carried slice REPLACES the derived
/// one, because it is only seeded when it explains more calls. Summing the two
/// would double-count every partly-surviving day. This is the read every headline
/// should use — `dayTotals` alone reports only what the sources still hold, which
/// on this corpus is $2,059 short across 16 days and misses pre-retention history
/// entirely.
export function dayTotalsWithCarried(index: UsageIndex, fromDay: string, toDay: string, provider?: string): DayTotals[] {
  const scoped = provider && provider !== 'all' ? provider : null
  const providerClause = scoped ? ' AND provider = ?' : ''
  const params: SqliteValue[] = [fromDay, toDay]
  if (scoped) params.push(scoped)

  type Slice = {
    cost: number; savings: number; calls: number
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
  }
  const slices = new Map<string, { day: string; provider: string; slice: Slice }>()
  const read = (sql: string): void => {
    for (const r of index.query<Row>(sql, params)) {
      slices.set(`${String(r['day'])}\u0000${String(r['provider'])}`, {
        day: String(r['day']),
        provider: String(r['provider']),
        slice: {
          cost: Number(r['cost'] ?? 0),
          savings: Number(r['savings'] ?? 0),
          calls: Number(r['calls'] ?? 0),
          inputTokens: Number(r['input_tokens'] ?? 0),
          outputTokens: Number(r['output_tokens'] ?? 0),
          cacheReadTokens: Number(r['cache_read_tokens'] ?? 0),
          cacheWriteTokens: Number(r['cache_write_tokens'] ?? 0),
        },
      })
    }
  }

  // Derived first, then carried overwrites the pairs it explains better.
  read(
    `SELECT day, provider,
            SUM(cost_usd) AS cost, SUM(savings_usd) AS savings, COUNT(*) AS calls,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens
       FROM call
      WHERE day BETWEEN ? AND ?${providerClause}
      GROUP BY day, provider`,
  )
  read(
    `SELECT day, provider,
            cost_usd AS cost, savings_usd AS savings, calls,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM carried_day
      WHERE day BETWEEN ? AND ?${providerClause}`,
  )

  const byDay = new Map<string, DayTotals>()
  for (const { day, provider, slice } of slices.values()) {
    const prior = byDay.get(day) ?? {
      day, providers: [], cost: 0, savings: 0, calls: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    // A provider whose slice is empty that day did not really run, and the old
    // path's Providers column never listed one.
    if (slice.cost > 0 || slice.calls > 0) prior.providers!.push(provider)
    prior.cost += slice.cost
    prior.savings += slice.savings
    prior.calls += slice.calls
    prior.inputTokens += slice.inputTokens
    prior.outputTokens += slice.outputTokens
    prior.cacheReadTokens += slice.cacheReadTokens
    prior.cacheWriteTokens += slice.cacheWriteTokens
    byDay.set(day, prior)
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/// `estimatedCost` is the part of `cost` priced from estimated tokens. Only
/// meaningful for a model breakdown; it drives the "~" marker on that row.
export type GroupTotals = { key: string; cost: number; calls: number; tokens: number; estimatedCost?: number }

export type IndexPeriod = {
  totals: {
    cost: number
    savings: number
    calls: number
    sessions: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  days: DayTotals[]
  byProvider: GroupTotals[]
  byModel: GroupTotals[]
  byCategory: Array<{ key: string; cost: number; turns: number }>
  byTool: Array<{ key: string; calls: number }>
  byProject: Array<{ key: string; label: string; cost: number; sessions: number }>
  /// Cost in the window that came from carried (sourceless) days. Such a day
  /// has no category, tool or project split, so those three panels are
  /// source-derived only and trail the headline by exactly this much.
  carriedCost: number
}

/// Everything an overview renders, for one window, from the index alone — no
/// provider store is opened. Headline and day/provider/model figures include
/// carried days (verified at parity with the daily cache); category, tool and
/// project cannot, because a sourceless day records none of those.
export function periodFromIndex(index: UsageIndex, fromDay: string, toDay: string, provider?: string): IndexPeriod {
  const scoped = provider && provider !== 'all' ? provider : null
  const scope = scoped ? ' AND provider = ?' : ''
  const params: SqliteValue[] = scoped ? [fromDay, toDay, scoped] : [fromDay, toDay]

  const days = dayTotalsWithCarried(index, fromDay, toDay, provider)
  const totals = days.reduce(
    (a, d) => ({
      cost: a.cost + d.cost,
      savings: a.savings + d.savings,
      calls: a.calls + d.calls,
      sessions: 0,
      inputTokens: a.inputTokens + d.inputTokens,
      outputTokens: a.outputTokens + d.outputTokens,
      cacheReadTokens: a.cacheReadTokens + d.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + d.cacheWriteTokens,
    }),
    { cost: 0, savings: 0, calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
  // Distinct sessions active in the window. Carried days contribute their own
  // session counts on top: they cannot be de-duplicated against live ones, which
  // is the same "at least" basis the old path reported.
  const [live] = index.query<Row>(
    `SELECT COUNT(DISTINCT session_uid) AS n FROM call WHERE day BETWEEN ? AND ?${scope}`,
    params,
  )
  const [carriedSessions] = index.query<Row>(
    `SELECT COALESCE(SUM(sessions), 0) AS n, COALESCE(SUM(cost_usd), 0) AS cost
       FROM carried_day WHERE day BETWEEN ? AND ?${scope}`,
    params,
  )
  totals.sessions = Number(live?.['n'] ?? 0) + Number(carriedSessions?.['n'] ?? 0)

  const byProvider = groupTotalsWithCarried(index, 'provider', fromDay, toDay)
    .filter(r => !scoped || r.key === scoped)
  // A provider-scoped model split reads derived rows only: a carried slice's
  // models are stored per (day, provider) but not attributed within it by model
  // AND provider together in a way this query could filter on cheaply.
  const byModel = scoped
    ? index.query<Row>(
        `SELECT model_key AS key, SUM(cost_usd) AS cost, COUNT(*) AS calls,
                SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
                SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END) AS estimated_cost
           FROM call WHERE day BETWEEN ? AND ? AND provider = ? GROUP BY key ORDER BY cost DESC`,
        params,
      ).map(r => ({
        key: String(r['key']),
        cost: Number(r['cost'] ?? 0),
        calls: Number(r['calls'] ?? 0),
        tokens: Number(r['tokens'] ?? 0),
        estimatedCost: Number(r['estimated_cost'] ?? 0),
      }))
    : groupTotalsWithCarried(index, 'model', fromDay, toDay)

  const byCategory = index.query<Row>(
    `SELECT COALESCE(category, 'general') AS key,
            SUM(cost_usd) AS cost, COUNT(DISTINCT turn_uid) AS turns
       FROM call WHERE day BETWEEN ? AND ?${scope}
      GROUP BY key ORDER BY cost DESC`,
    params,
  ).map(r => ({ key: String(r['key']), cost: Number(r['cost'] ?? 0), turns: Number(r['turns'] ?? 0) }))

  const byTool = index.query<Row>(
    scoped
      ? `SELECT t.tool AS key, COUNT(*) AS calls
           FROM call_tool t JOIN call c ON c.uid = t.call_uid
          WHERE t.day BETWEEN ? AND ? AND c.provider = ?
          GROUP BY key ORDER BY calls DESC`
      : `SELECT tool AS key, COUNT(*) AS calls
           FROM call_tool WHERE day BETWEEN ? AND ?
          GROUP BY key ORDER BY calls DESC`,
    params,
  ).map(r => ({ key: String(r['key']), calls: Number(r['calls'] ?? 0) }))

  const byProject = index.query<Row>(
    `SELECT COALESCE(s.project_path, s.project_label, '(unknown)') AS key,
            MAX(COALESCE(s.project_label, s.project_path, '(unknown)')) AS label,
            SUM(c.cost_usd) AS cost, COUNT(DISTINCT c.session_uid) AS sessions
       FROM call c JOIN session s ON s.uid = c.session_uid
      WHERE c.day BETWEEN ? AND ?${scoped ? ' AND c.provider = ?' : ''}
      GROUP BY key ORDER BY cost DESC`,
    params,
  ).map(r => ({
    key: String(r['key']),
    label: String(r['label']),
    cost: Number(r['cost'] ?? 0),
    sessions: Number(r['sessions'] ?? 0),
  }))

  return {
    totals,
    days,
    byProvider,
    byModel,
    byCategory,
    byTool,
    byProject,
    carriedCost: Number(carriedSessions?.['cost'] ?? 0),
  }
}

/// Provider and model breakdowns that include carried days.
///
/// A carried slice REPLACES the derived one for its (day, provider) pair, so the
/// derived half must exclude those pairs or a partly-surviving day is counted
/// twice — the same trap `dayTotalsWithCarried` avoids, but it has to be spelled
/// out in SQL here because the grouping is no longer by day.
///
/// `project` is deliberately absent: a carried slice knows its provider and its
/// models (the cache records both per day), but per-project day stats only exist
/// from cache v15 onward and are dropped for a sourceless slice, so a carried day
/// genuinely cannot be attributed to a project. Callers that need a project
/// breakdown get `groupTotals`, which is source-derived only — and a caller
/// showing it over a window reaching past source retention has to say so rather
/// than quietly present it as the whole picture.
export function groupTotalsWithCarried(
  index: UsageIndex,
  groupBy: 'provider' | 'model',
  fromDay: string,
  toDay: string,
): GroupTotals[] {
  const totals = new Map<string, GroupTotals>()
  const add = (key: string, cost: number, calls: number, tokens: number, estimatedCost = 0): void => {
    const prior = totals.get(key) ?? { key, cost: 0, calls: 0, tokens: 0, estimatedCost: 0 }
    prior.cost += cost
    prior.calls += calls
    prior.tokens += tokens
    prior.estimatedCost = (prior.estimatedCost ?? 0) + estimatedCost
    totals.set(key, prior)
  }

  // Derived, minus every pair a carried slice speaks for. Models group by
  // model_key, the same display key the cache and every report use.
  const column = groupBy === 'model' ? 'model_key' : 'provider'
  for (const r of index.query<Row>(
    `SELECT ${column} AS key,
            SUM(cost_usd) AS cost, COUNT(*) AS calls,
            SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
            SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END) AS estimated_cost
       FROM call c
      WHERE day BETWEEN ? AND ?
        AND NOT EXISTS (
          SELECT 1 FROM carried_day cd WHERE cd.day = c.day AND cd.provider = c.provider
        )
      GROUP BY key`,
    [fromDay, toDay],
  )) {
    add(String(r['key']), Number(r['cost'] ?? 0), Number(r['calls'] ?? 0), Number(r['tokens'] ?? 0), Number(r['estimated_cost'] ?? 0))
  }

  if (groupBy === 'provider') {
    for (const r of index.query<Row>(
      `SELECT provider AS key, SUM(cost_usd) AS cost, SUM(calls) AS calls,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
         FROM carried_day WHERE day BETWEEN ? AND ? GROUP BY key`,
      [fromDay, toDay],
    )) {
      add(String(r['key']), Number(r['cost'] ?? 0), Number(r['calls'] ?? 0), Number(r['tokens'] ?? 0))
    }
  } else {
    // Model rows ride along as JSON, because a carried slice is day-grained and
    // a model column would need its own table for what is a handful of rows.
    for (const r of index.query<Row>(
      'SELECT models_json FROM carried_day WHERE day BETWEEN ? AND ? AND models_json IS NOT NULL',
      [fromDay, toDay],
    )) {
      let models: Record<string, { cost?: number; calls?: number; tokens?: number }>
      try {
        models = JSON.parse(String(r['models_json'])) as typeof models
      } catch {
        // A malformed blob loses this slice's model split, never the run.
        continue
      }
      for (const [name, m] of Object.entries(models)) {
        add(name, Number(m.cost ?? 0), Number(m.calls ?? 0), Number(m.tokens ?? 0))
      }
    }
  }

  return [...totals.values()].sort((a, b) => b.cost - a.cost)
}

/// Per-provider / per-model / per-project totals for a window. One statement per
/// grouping rather than one pass over a parsed corpus per panel.
export function groupTotals(
  index: UsageIndex,
  groupBy: 'provider' | 'model' | 'project',
  fromDay: string,
  toDay: string,
): GroupTotals[] {
  const sql = groupBy === 'project'
    ? `SELECT COALESCE(s.project_label, s.project_path, '(unknown)') AS key,
              SUM(c.cost_usd) AS cost, COUNT(*) AS calls,
              SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_tokens) AS tokens
         FROM call c JOIN session s ON s.uid = c.session_uid
        WHERE c.day BETWEEN ? AND ?
        GROUP BY key ORDER BY cost DESC`
    : `SELECT ${groupBy === 'model' ? 'model_key' : 'provider'} AS key,
              SUM(cost_usd) AS cost, COUNT(*) AS calls,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
         FROM call
        WHERE day BETWEEN ? AND ?
        GROUP BY key ORDER BY cost DESC`
  return index.query<Row>(sql, [fromDay, toDay]).map(r => ({
    key: String(r['key']),
    cost: Number(r['cost'] ?? 0),
    calls: Number(r['calls'] ?? 0),
    tokens: Number(r['tokens'] ?? 0),
  }))
}
