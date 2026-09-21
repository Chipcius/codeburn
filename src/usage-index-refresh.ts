import { spawn } from 'child_process'
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'fs'
import { join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'

/// How old the index may get before a reader kicks a background refresh. The
/// reader never waits on it: it answers from the index it has, says how old that
/// is, and the next read gets the fresher one. That is the split between the
/// read path and ingestion — a UI must not pay for a parse to show a number.
export const INDEX_STALE_AFTER_MS = 5 * 60 * 1000

/// A refresh that has been "running" longer than this is presumed dead (killed,
/// machine slept mid-parse) and may be replaced, or one crash would disable
/// background refresh forever.
const INGEST_LOCK_EXPIRY_MS = 15 * 60 * 1000

function lockPath(): string {
  return join(getCodeburnCacheDir(), 'usage-index.ingest.lock')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/// True while another process holds a live, unexpired ingest lock. Several
/// commands firing at once (a dashboard poll plus a `status` in a shell prompt)
/// must share one refresh, not each start a full parse of the corpus.
export function ingestInProgress(now: number = Date.now()): boolean {
  const path = lockPath()
  if (!existsSync(path)) return false
  try {
    const { pid, startedAt } = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; startedAt: number }
    return now - startedAt < INGEST_LOCK_EXPIRY_MS && processAlive(pid)
  } catch {
    return false
  }
}

/// Take the ingest lock for the current process. Returns a release function, or
/// null when a live refresh already holds it. `wx` makes creation atomic, so two
/// racing refreshes cannot both believe they won.
export function acquireIngestLock(): (() => void) | null {
  const path = lockPath()
  if (ingestInProgress()) return null
  // A stale lock from a dead process is cleared so this run can take it.
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* another process cleared it first; the exclusive create decides */
  }
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch {
    return null
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  closeSync(fd)
  return () => {
    try {
      const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
      if (held.pid === process.pid) unlinkSync(path)
    } catch {
      /* already gone */
    }
  }
}

/// Start `codeburn index build` detached from the caller, which returns
/// immediately. Output is discarded: it runs behind a UI that has already
/// answered, and a failure simply leaves the previous index in place.
export function scheduleBackgroundIngest(): boolean {
  if (ingestInProgress()) return false
  const script = process.argv[1]
  if (!script) return false
  try {
    const child = spawn(process.execPath, [script, 'index', 'build'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CODEBURN_BACKGROUND_INGEST: '1' },
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

export function describeIndexAge(lastIngestAt: number | null, now: number = Date.now()): string {
  if (lastIngestAt === null) return 'never built'
  const minutes = Math.floor((now - lastIngestAt) / 60000)
  if (minutes < 1) return 'updated just now'
  if (minutes < 60) return `updated ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `updated ${hours}h ago`
}
