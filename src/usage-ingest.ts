import { dateKey } from './day-aggregator.js'
import { modelRowKey } from './models.js'
import {
  deleteSourceRows,
  insertCalls,
  insertSessions,
  type CallRecord,
  type SessionRecord,
  type UsageIndex,
} from './usage-index.js'
import type { ClassifiedTurn, ProjectSummary, SessionSummary } from './types.js'

/// Turns a parsed corpus into index rows. This is the only place that reads a
/// provider's own store, and it runs off the read path: a UI asks the index, and
/// the index is filled here.
///
/// Costs are taken as the parser computed them rather than recomputed from
/// tokens. Pricing is per-call (a long-context tier, a 1-hour cache write, fast
/// mode), so a SUM over stored costs is the only aggregate that cannot drift
/// from what was actually attributed — the mistake `audit` made by multiplying
/// summed tokens by one rate row.

/// Stable identity for a session across re-ingests. Mirrors the key the parser
/// uses to merge turns into a session, so re-reading a file lands on the same row
/// instead of creating a second one.
export function sessionUid(provider: string, sessionId: string, project: string): string {
  return `${provider}:${sessionId}:${project}`
}

function sessionSourcePath(session: SessionSummary, fallback: string | null): string | null {
  return session.source?.path ?? fallback
}

/// One session's calls, flattened. `deduplicationKey` is the parser's own
/// cross-file identity for a call, so it is the primary key: the same API
/// response seen in a resumed transcript AND its original cannot become two rows
/// (61% of this corpus's assistant lines are such duplicates).
function callRecords(uid: string, turns: readonly ClassifiedTurn[]): CallRecord[] {
  const records: CallRecord[] = []
  for (const turn of turns) {
    for (const call of turn.assistantCalls) {
      // dateKey builds the string from Date fields, so an unparseable stamp
      // yields "NaN-NaN-NaN" rather than an empty string. Reject on the parse,
      // not on the output, or a row lands on a day no range can ever select.
      const stamp = call.timestamp || turn.timestamp || ''
      if (!stamp || Number.isNaN(Date.parse(stamp))) continue
      const day = dateKey(stamp)
      const u = call.usage
      const oneHour = Math.max(0, call.cacheCreationOneHourTokens ?? 0)
      records.push({
        uid: call.deduplicationKey || `${uid}:${call.timestamp}:${records.length}`,
        sessionUid: uid,
        provider: call.provider || 'unknown',
        model: call.model || 'unknown',
        // The same key parser.ts uses for modelBreakdown, so an index breakdown
        // and a report breakdown name the same row. Devin is the one provider
        // that keeps its raw id, mirroring that exception.
        modelKey: call.provider === 'devin'
          ? (call.model || 'unknown')
          : modelRowKey(call.model || 'unknown', call.route),
        day,
        ts: call.timestamp || null,
        category: turn.category ?? null,
        speed: call.speed ?? 'standard',
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        reasoningTokens: u.reasoningTokens,
        // Providers fill one cache-read vocabulary or both; the reports collapse
        // them to their max, so the index stores the collapsed figure.
        cacheReadTokens: Math.max(u.cacheReadInputTokens, u.cachedInputTokens),
        cacheWriteTokens: Math.max(u.cacheCreationInputTokens, oneHour),
        cacheWrite1h: oneHour,
        webSearches: u.webSearchRequests,
        costUSD: call.costUSD,
        savingsUSD: call.savingsUSD ?? 0,
      })
    }
  }
  return records
}

export type IngestStats = { sessions: number; calls: number; sources: number }

/// Write a parsed corpus into the index, replacing whatever each source
/// contributed before. One transaction per call: a partial ingest that dies
/// mid-way must not leave a session whose calls are half-written, and the
/// per-source delete makes a re-ingest idempotent rather than additive.
export function ingestProjects(index: UsageIndex, projects: readonly ProjectSummary[]): IngestStats {
  const sessions: SessionRecord[] = []
  const calls: CallRecord[] = []
  const sourcePaths = new Set<string>()

  for (const project of projects) {
    for (const session of project.sessions) {
      const provider = session.turns[0]?.assistantCalls[0]?.provider ?? 'unknown'
      const uid = sessionUid(provider, session.sessionId, session.project)
      const sourcePath = sessionSourcePath(session, null)
      if (sourcePath) sourcePaths.add(sourcePath)
      sessions.push({
        uid,
        provider,
        sessionId: session.sessionId,
        sourcePath,
        projectPath: project.projectPath ?? null,
        projectLabel: session.project || null,
        firstTs: session.firstTimestamp || null,
        lastTs: session.lastTimestamp || null,
      })
      calls.push(...callRecords(uid, session.turns))
    }
  }

  index.transaction(() => {
    for (const path of sourcePaths) deleteSourceRows(index, path)
    insertSessions(index, sessions)
    insertCalls(index, calls)
  })

  return { sessions: sessions.length, calls: calls.length, sources: sourcePaths.size }
}
