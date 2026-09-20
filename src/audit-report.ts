import { isBehavioralCall } from './behavioral-weight.js'
import { ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE, billableOutputTokens, fallbackRawModelDisplayName, getModelCosts, getShortModelName, sanitizeModelForDisplay, tieredCostsFor, type ModelCosts } from './models.js'
import { getProvider } from './providers/index.js'
import { formatCost, formatTokens } from './format.js'
import { renderTable, type TableColumn } from './text-table.js'
import type { ProjectSummary } from './types.js'

// One (provider, model) bucket, exposing both the raw token fields as recorded
// by the provider/transcript and the normalized totals codeburn actually
// prices, so a mismatch between the two is visible in one place.
export type AuditRow = {
  provider: string
  providerDisplayName: string
  model: string
  modelDisplayName: string
  calls: number
  // Summed straight from each call's usage, untouched.
  raw: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number // Anthropic vocab
    cachedInputTokens: number // OpenAI vocab
    webSearchRequests: number
  }
  // What the reports display: reasoning folds into output, and the two
  // cache-read vocabularies collapse to their max (providers fill one or both).
  // Cache writes split by TTL because the two are priced differently.
  displayed: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheWriteFiveMinuteTokens: number
    cacheWriteOneHourTokens: number
    cacheReadTokens: number
    fastCalls: number
  }
  // Per-token rates used for pricing; null when the model has no pricing entry.
  rates: ModelCosts | null
  // Cost split by component, plus the recomputed total. The two cache-write
  // TTLs are separate lines: Anthropic prices a 1-hour write at 1.6x the
  // 5-minute rate this table stores, so collapsing them understated the
  // recomputed total on every Claude Code corpus (its writes are mostly 1h) and
  // made the column disagree with the cost actually attributed.
  cost: {
    input: number
    output: number
    cacheWrite: number
    cacheWriteOneHour: number
    cacheRead: number
    webSearch: number
    recomputedTotalUSD: number
  }
  // The cost codeburn actually attributed to these calls (sum of call.costUSD).
  attributedCostUSD: number
}

export async function aggregateAudit(projects: ProjectSummary[]): Promise<AuditRow[]> {
  type Bucket = {
    provider: string
    model: string
    calls: number
    attributedCostUSD: number
    cacheReadDisplayed: number
    raw: AuditRow['raw']
    // Cache writes split by TTL, and the component costs accumulated per call so
    // per-request modifiers (tier, TTL, fast mode) land on the request that
    // earned them rather than on a period-wide average. A bucket's summed
    // tokens must never cross the per-call tier threshold on their own.
    oneHourCacheWriteTokens: number
    fiveMinuteCacheWriteTokens: number
    fastCalls: number
    billableOutputTokens: number
    cost: { input: number; output: number; cacheWrite: number; cacheWriteOneHour: number; cacheRead: number; webSearch: number }
    ratedCalls: number
    /** Resolved base rates for the bucket's model, fetched once per bucket. */
    rates: ModelCosts | null
  }
  const buckets = new Map<string, Bucket>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          const provider = call.provider || 'unknown'
          const model = call.model || 'unknown'
          const key = `${provider} ${model}`
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = {
              provider,
              model,
              calls: 0,
              attributedCostUSD: 0,
              cacheReadDisplayed: 0,
              rates: null,
              raw: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cachedInputTokens: 0,
                webSearchRequests: 0,
              },
              oneHourCacheWriteTokens: 0,
              fiveMinuteCacheWriteTokens: 0,
              fastCalls: 0,
              billableOutputTokens: 0,
              cost: { input: 0, output: 0, cacheWrite: 0, cacheWriteOneHour: 0, cacheRead: 0, webSearch: 0 },
              ratedCalls: 0,
            }
            bucket.rates = getModelCosts(bucket.model)
            buckets.set(key, bucket)
          }
          const u = call.usage
          bucket.raw.inputTokens += u.inputTokens
          bucket.raw.outputTokens += u.outputTokens
          bucket.raw.reasoningTokens += u.reasoningTokens
          bucket.raw.cacheCreationInputTokens += u.cacheCreationInputTokens
          bucket.raw.cacheReadInputTokens += u.cacheReadInputTokens
          bucket.raw.cachedInputTokens += u.cachedInputTokens
          bucket.raw.webSearchRequests += u.webSearchRequests
          // Per-call max (then summed) mirrors how the reports collapse the two
          // cache-read vocabularies, so the audit's displayed total matches.
          const cacheReadForCall = Math.max(u.cacheReadInputTokens, u.cachedInputTokens)
          bucket.cacheReadDisplayed += cacheReadForCall
          bucket.attributedCostUSD += call.costUSD

          // Recompute per call through the same tier swap calculateCost applies
          // (prompt tokens = input + cached input of THIS call), so a
          // long-context request shows the rates that priced it while a bucket
          // of small calls never crosses the threshold on the sum. The two gaps
          // #1076 left open on purpose — fast mode and the 1-hour cache-write
          // rate — are closed here too, so the recompute reconciles exactly
          // instead of trailing the attributed cost on every Claude corpus.
          const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
          const oneHour = nonNeg(call.cacheCreationOneHourTokens ?? 0)
          const totalWrite = Math.max(nonNeg(u.cacheCreationInputTokens), oneHour)
          const fiveMinute = Math.max(0, totalWrite - oneHour)
          bucket.oneHourCacheWriteTokens += oneHour
          bucket.fiveMinuteCacheWriteTokens += fiveMinute
          if (call.speed === 'fast') bucket.fastCalls += 1
          const outputForCall = billableOutputTokens(bucket.provider, u.outputTokens, u.reasoningTokens)
          bucket.billableOutputTokens += outputForCall
          if (bucket.rates) {
            bucket.ratedCalls += 1
            const promptTokens = nonNeg(u.inputTokens) + cacheReadForCall
            const tiered = tieredCostsFor(bucket.model, bucket.rates, promptTokens, bucket.provider)
            const multiplier = call.speed === 'fast' ? tiered.fastMultiplier : 1
            bucket.cost.input += multiplier * nonNeg(u.inputTokens) * tiered.inputCostPerToken
            bucket.cost.output += multiplier * outputForCall * tiered.outputCostPerToken
            bucket.cost.cacheWrite += multiplier * fiveMinute * tiered.cacheWriteCostPerToken
            bucket.cost.cacheWriteOneHour += multiplier * oneHour * tiered.cacheWriteCostPerToken * ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE
            bucket.cost.cacheRead += multiplier * cacheReadForCall * tiered.cacheReadCostPerToken
            // Web search never participates in a tier; keep it on the base row.
            bucket.cost.webSearch += multiplier * nonNeg(u.webSearchRequests) * bucket.rates.webSearchCostPerRequest
          }
          // Supplementary accounting calls keep their tokens and cost above but are not
          // distinct requests, so they add no call weight (see behavioral-weight.ts).
          if (isBehavioralCall(call)) bucket.calls += 1
        }
      }
    }
  }

  const providerCache = new Map<string, { displayName: string; formatModel: (m: string) => string }>()
  async function resolveProvider(name: string) {
    const cached = providerCache.get(name)
    if (cached) return cached
    const p = await getProvider(name)
    const entry = {
      displayName: p?.displayName ?? name,
      formatModel: p
        ? (m: string) => sanitizeModelForDisplay(fallbackRawModelDisplayName(p.modelDisplayName(m), m))
        : (m: string) => sanitizeModelForDisplay(getShortModelName(m)),
    }
    providerCache.set(name, entry)
    return entry
  }

  const rows: AuditRow[] = []
  for (const bucket of buckets.values()) {
    const meta = await resolveProvider(bucket.provider)
    // Buckets are keyed by (provider, model), so this provider test covers every call in one.
    // Copilot reasoning tokens are already INSIDE outputTokens (same rule as cachedCallToApiCall
    // in parser.ts), so folding them in would display phantom output for its store rows/rollups.
    const displayed = {
      inputTokens: bucket.raw.inputTokens,
      outputTokens: bucket.billableOutputTokens,
      cacheWriteTokens: Math.max(bucket.raw.cacheCreationInputTokens, bucket.oneHourCacheWriteTokens),
      cacheWriteFiveMinuteTokens: bucket.fiveMinuteCacheWriteTokens,
      cacheWriteOneHourTokens: bucket.oneHourCacheWriteTokens,
      cacheReadTokens: bucket.cacheReadDisplayed,
      fastCalls: bucket.fastCalls,
    }
    // `rates` is the model's base (short-context) row, for reference. The costs
    // below are NOT derived from it: they were accumulated per call, each at the
    // tier, TTL and speed that request actually fell into.
    const rates = bucket.rates
    const cost = {
      input: bucket.cost.input,
      output: bucket.cost.output,
      cacheWrite: bucket.cost.cacheWrite,
      cacheWriteOneHour: bucket.cost.cacheWriteOneHour,
      cacheRead: bucket.cost.cacheRead,
      webSearch: bucket.cost.webSearch,
      recomputedTotalUSD: 0,
    }
    cost.recomputedTotalUSD = cost.input + cost.output + cost.cacheWrite + cost.cacheWriteOneHour + cost.cacheRead + cost.webSearch
    rows.push({
      provider: bucket.provider,
      providerDisplayName: meta.displayName,
      model: bucket.model,
      modelDisplayName: meta.formatModel(bucket.model),
      calls: bucket.calls,
      raw: bucket.raw,
      displayed,
      rates,
      cost,
      attributedCostUSD: bucket.attributedCostUSD,
    })
  }

  rows.sort((a, b) => b.attributedCostUSD - a.attributedCostUSD)
  return rows
}

export function renderAuditTable(rows: AuditRow[]): string {
  const columns: TableColumn[] = [
    { header: 'Provider' },
    { header: 'Model' },
    { header: 'Calls', right: true },
    { header: 'Input', right: true },
    { header: 'Output', right: true },
    { header: 'Reason', right: true },
    { header: 'Cache wr 5m', right: true },
    { header: 'Cache wr 1h', right: true },
    { header: 'Cache rd', right: true },
    { header: 'Cost', right: true },
  ]

  const body = rows.map((r) => [
    r.providerDisplayName,
    r.modelDisplayName,
    r.calls.toLocaleString(),
    formatTokens(r.raw.inputTokens),
    formatTokens(r.raw.outputTokens),
    formatTokens(r.raw.reasoningTokens),
    formatTokens(r.displayed.cacheWriteFiveMinuteTokens),
    formatTokens(r.displayed.cacheWriteOneHourTokens),
    formatTokens(r.displayed.cacheReadTokens),
    formatCost(r.attributedCostUSD),
  ])

  const totals = rows.reduce(
    (a, r) => ({
      calls: a.calls + r.calls,
      input: a.input + r.raw.inputTokens,
      output: a.output + r.raw.outputTokens,
      reason: a.reason + r.raw.reasoningTokens,
      cacheWrite5m: a.cacheWrite5m + r.displayed.cacheWriteFiveMinuteTokens,
      cacheWrite1h: a.cacheWrite1h + r.displayed.cacheWriteOneHourTokens,
      cacheRead: a.cacheRead + r.displayed.cacheReadTokens,
      cost: a.cost + r.attributedCostUSD,
    }),
    { calls: 0, input: 0, output: 0, reason: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0 },
  )
  body.push([
    'Total',
    '',
    totals.calls.toLocaleString(),
    formatTokens(totals.input),
    formatTokens(totals.output),
    formatTokens(totals.reason),
    formatTokens(totals.cacheWrite5m),
    formatTokens(totals.cacheWrite1h),
    formatTokens(totals.cacheRead),
    formatCost(totals.cost),
  ])

  const table = renderTable(columns, body, { boldRows: new Set([body.length - 1]) })
  const legend = [
    '',
    'Columns are the raw token fields each provider records. codeburn then normalizes for pricing:',
    '  - Reason folds into Output (priced output = output + reasoning), except copilot, whose reasoning is already inside its output',
    '  - Cache rd = max(Anthropic cacheReadInput, OpenAI cached), since providers fill one or both',
    '  - Cache wr is priced at 1.25x the input rate, Cache rd at 0.1x, when a model omits explicit cache rates',
    `  - Cache wr 1h costs ${ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE}x Cache wr 5m (Anthropic bills a 1-hour write at 2x base input, a 5-minute write at 1.25x)`,
    '  - A request whose prompt crosses a vendor long-context threshold is priced entirely at that vendor\'s high tier',
    'Cost is what codeburn attributed. Each call is priced at its own tier, TTL and speed, so a',
    'period total cannot be reproduced by multiplying these summed tokens by one rate row.',
    'Use --format json for per-component cost, the rates applied, and both raw cache-read fields.',
  ].join('\n')
  return table + '\n' + legend
}

export function renderAuditJson(rows: AuditRow[]): string {
  return JSON.stringify(rows, null, 2)
}
