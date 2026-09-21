import { getDateRange } from './cli-date.js'
import { buildMenubarPayloadForRange } from './usage-aggregator.js'
import { storePayload, type UsageIndex } from './usage-index.js'

/// The period tabs every dashboard opens on. These are the payloads the worker
/// materializes; any other request (a provider filter, a custom range, a pinned
/// day) is answered by the live builder as before.
export const MATERIALIZED_PERIODS = ['today', 'week', '30days', 'month', 'all', 'lifetime'] as const

export function payloadKey(period: string, provider: string): string {
  return `menubar|${period}|${provider}`
}

/// Run codeburn's own payload builder for each standard period and store the
/// result. Called by the worker right after an ingest, while the session parse it
/// just did is still warm in this process, so each period after the first is
/// aggregation over cached sessions rather than another read of the stores.
///
/// The options mirror web-dashboard.ts's getLocalPayload exactly (provider
/// 'all', optimize off), so a materialized payload is byte-for-byte what that
/// request would have built live. A period that fails to build is skipped and
/// leaves its previous payload in place: stale beats missing.
export async function materializePayloads(index: UsageIndex): Promise<{ built: number; failed: string[] }> {
  const failed: string[] = []
  let built = 0
  for (const period of MATERIALIZED_PERIODS) {
    try {
      const payload = await buildMenubarPayloadForRange(getDateRange(period), { provider: 'all', optimize: false })
      storePayload(index, payloadKey(period, 'all'), JSON.stringify(payload))
      built++
    } catch (err) {
      failed.push(`${period}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { built, failed }
}
