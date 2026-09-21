import { watch, type FSWatcher } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { getAllProviders } from './providers/index.js'
import { buildIndex } from './usage-index-build.js'
import { acquireIngestLock } from './usage-index-refresh.js'
import { lastIngestAt, openUsageIndex } from './usage-index.js'

/// The worker that keeps the usage index current. Provider stores are WATCHED and
/// INGESTED here, never queried by a UI: every surface reads the index, and this
/// is what moves its figures forward.

/// Settle time: a burst of writes (a model streaming a long turn appends to a
/// transcript many times a second) triggers one rebuild, not one per write.
const QUIET_MS = 4_000
/// Continuous activity must not starve the index. An active session writes
/// without pause, so a pure quiet-period debounce would never fire while you
/// work, which is exactly when you are looking at the numbers.
const MAX_DELAY_MS = 60_000
/// Inotify can miss events (a filesystem that does not deliver them, a watch
/// dropped when its directory was replaced), so rebuild on a timer regardless.
const SAFETY_REBUILD_MS = 15 * 60_000

/// Recursive fs.watch on Linux costs one inotify watch PER DIRECTORY, drawn from
/// a per-user budget shared with every editor, IDE and dev server on the machine
/// (`fs.inotify.max_user_watches`, 65,536 here). One OpenCode store measured
/// 65,513 directories — watching it recursively would take essentially all of
/// that budget and silently break file watching for everything else. So each
/// root is measured first, and one too large is watched at its top level only.
/// For OpenCode that is enough: live data lands in opencode.db and its -wal/-shm
/// siblings at the top level, and the huge tree beneath is static legacy JSON.
const RECURSIVE_ROOT_DIR_LIMIT = 5_000
/// Total directories this process may watch, kept far under the system limit so
/// codeburn is never the reason another tool's watcher fails.
const TOTAL_WATCH_BUDGET = 20_000

/// Directory count under `root`, stopping once it passes `limit` so a huge tree
/// is judged in milliseconds rather than fully walked.
async function countDirs(root: string, limit: number): Promise<number> {
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    count++
    if (count > limit) return count
    for (const e of entries) if (e.isDirectory()) stack.push(join(dir, e.name))
  }
  return count
}

type WatchPlan = { root: string; recursive: boolean; dirs: number }

/// Decide how to watch each provider root. Pure over the measured counts, so the
/// budget rule can be tested without a filesystem.
export function planWatches(
  roots: ReadonlyArray<{ root: string; dirs: number }>,
  limits: { perRoot: number; total: number } = { perRoot: RECURSIVE_ROOT_DIR_LIMIT, total: TOTAL_WATCH_BUDGET },
): WatchPlan[] {
  let spent = 0
  // Smallest first, so one large root cannot crowd out several small ones.
  return [...roots].sort((a, b) => a.dirs - b.dirs).map(({ root, dirs }) => {
    const recursive = dirs <= limits.perRoot && spent + dirs <= limits.total
    spent += recursive ? dirs : 1
    return { root, recursive, dirs }
  })
}

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`)
}

async function sourceRoots(provider?: string): Promise<string[]> {
  const providers = await getAllProviders()
  const roots = new Set<string>()
  for (const p of providers) {
    if (provider && provider !== 'all' && p.name !== provider) continue
    if (!p.probeRoots) continue
    for (const r of await p.probeRoots()) {
      try {
        if ((await stat(r.path)).isDirectory()) roots.add(r.path)
      } catch {
        /* tool not installed: nothing to watch */
      }
    }
  }
  return [...roots]
}

export async function watchAndIngest(opts: { provider?: string } = {}): Promise<void> {
  const roots = await sourceRoots(opts.provider)
  const measured = await Promise.all(roots.map(async root => ({ root, dirs: await countDirs(root, RECURSIVE_ROOT_DIR_LIMIT) })))
  const plan = planWatches(measured)

  const watchers: FSWatcher[] = []
  let dirty = false
  let firstDirtyAt = 0
  let quietTimer: NodeJS.Timeout | null = null
  let building = false

  const runBuild = async (reason: string): Promise<void> => {
    if (building) {
      dirty = true
      return
    }
    const release = acquireIngestLock()
    if (!release) {
      // Someone else (a foreground `index build`) is on it; try again shortly.
      dirty = true
      scheduleFlush()
      return
    }
    building = true
    dirty = false
    firstDirtyAt = 0
    try {
      const r = await buildIndex({ provider: opts.provider })
      log(`${reason}: ${r.calls.toLocaleString('en-US')} calls in ${((r.parseMs + r.writeMs) / 1000).toFixed(1)}s`)
    } catch (err) {
      log(`build failed (${reason}): ${err instanceof Error ? err.message : String(err)}`)
      // Leave it dirty so the next event or the safety timer retries.
      dirty = true
    } finally {
      building = false
      release()
      if (dirty) scheduleFlush()
    }
  }

  const scheduleFlush = (): void => {
    if (quietTimer) clearTimeout(quietTimer)
    const waited = firstDirtyAt ? Date.now() - firstDirtyAt : 0
    const delay = Math.max(0, Math.min(QUIET_MS, MAX_DELAY_MS - waited))
    quietTimer = setTimeout(() => {
      quietTimer = null
      if (dirty) void runBuild('change')
    }, delay)
  }

  const onChange = (): void => {
    if (!dirty) firstDirtyAt = Date.now()
    dirty = true
    scheduleFlush()
  }

  for (const { root, recursive, dirs } of plan) {
    try {
      watchers.push(watch(root, { recursive, persistent: true }, onChange))
      log(`watching ${root} ${recursive ? `(recursive, ${dirs} dirs)` : `(top level only: ${dirs > RECURSIVE_ROOT_DIR_LIMIT ? `>${RECURSIVE_ROOT_DIR_LIMIT}` : dirs} dirs)`}`)
    } catch (err) {
      log(`cannot watch ${root}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (watchers.length === 0) log('no source roots found; relying on the periodic rebuild')

  // Build now unless the index is already current, so the first read after
  // starting the watcher is fresh.
  let fresh = false
  try {
    const index = openUsageIndex({ readOnly: true })
    try {
      const at = lastIngestAt(index)
      fresh = at !== null && Date.now() - at < QUIET_MS * 2
    } finally {
      index.close()
    }
  } catch {
    /* no index yet */
  }
  if (!fresh) await runBuild('startup')

  const safety = setInterval(() => void runBuild('periodic'), SAFETY_REBUILD_MS)

  await new Promise<void>(resolve => {
    const stop = (): void => {
      log('stopping')
      clearInterval(safety)
      if (quietTimer) clearTimeout(quietTimer)
      for (const w of watchers) w.close()
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
