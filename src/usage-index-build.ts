import { loadDailyCache } from './daily-cache.js'
import { loadPricing } from './models.js'
import { parseAllSessions } from './parser.js'
import { markIngested, openUsageIndex, seedCarriedDays, type CarriedDayRow } from './usage-index.js'
import { ingestProjects, type IngestStats } from './usage-ingest.js'

export type BuildResult = IngestStats & {
  carried: number
  parseMs: number
  writeMs: number
  /// Time spent materializing UI payloads, and how many landed.
  payloadMs: number
  payloads: number
  payloadFailures: string[]
  path: string
}

/// One full rebuild of the usage index. The only code that reads the provider
/// stores to fill it; both `codeburn index build` and the watcher call this, so
/// a foreground rebuild and a background one cannot disagree about what "built"
/// means. Callers hold the ingest lock (see usage-index-refresh.ts).
export async function buildIndex(opts: { provider?: string } = {}): Promise<BuildResult> {
  const provider = opts.provider && opts.provider !== 'all' ? opts.provider : undefined
  await loadPricing()
  const index = openUsageIndex()
  try {
    const started = Date.now()
    // Full parse on purpose: the read path no longer pays for it, and this is
    // the one place that does. The warm session cache keeps it to seconds.
    const projects = await parseAllSessions(undefined, provider)
    const parsed = Date.now()
    const stats = ingestProjects(index, projects, provider ? { kind: 'provider', provider } : { kind: 'all' })

    // Days no source can explain any more, from the durable daily cache.
    // Re-seeded after every write because the rule is "carry only what the
    // index explains worse", and what the index explains just changed.
    const cache = await loadDailyCache()
    const carried = seedCarriedDays(index, cache.days.flatMap(day =>
      Object.entries(day.providers).map(([p, slice]): CarriedDayRow => ({
        day: day.date,
        provider: p,
        cost: slice.cost,
        savings: slice.savingsUSD ?? 0,
        calls: slice.calls,
        sessions: slice.sessions ?? 0,
        inputTokens: slice.inputTokens ?? 0,
        outputTokens: slice.outputTokens ?? 0,
        cacheReadTokens: slice.cacheReadTokens ?? 0,
        cacheWriteTokens: slice.cacheWriteTokens ?? 0,
        models: Object.fromEntries(Object.entries(slice.models ?? {}).map(([name, m]) => [name, {
          cost: m.cost,
          calls: m.calls,
          tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens,
        }])),
      })),
    ))
    markIngested(index)
    const written = Date.now()

    // Only a full, all-provider build materializes: a provider-scoped build has
    // not refreshed the other providers, so an all-provider payload built now
    // would mix a fresh provider with stale ones.
    let payloads = 0
    let payloadFailures: string[] = []
    if (!provider) {
      const { materializePayloads } = await import('./usage-index-payloads.js')
      const r = await materializePayloads(index)
      payloads = r.built
      payloadFailures = r.failed
    }
    return {
      ...stats,
      carried,
      parseMs: parsed - started,
      writeMs: written - parsed,
      payloadMs: Date.now() - written,
      payloads,
      payloadFailures,
      path: index.path,
    }
  } finally {
    index.close()
  }
}
