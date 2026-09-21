import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { fetchUsage, type Payload, type Period } from '../lib/api'
import { computeForecast, computeStats, heatmapWeeks, type HeatCell } from './insights'

type ProviderDetail = { id: string; label: string; cost: number; calls: number; hasUsage: boolean }
type PopoverPayload = Payload & {
  stale?: boolean
  current: Payload['current'] & { providerDetails?: ProviderDetail[] }
}

const PERIOD_TABS: Array<{ key: Period; label: string; heading: string }> = [
  { key: 'today', label: 'Today', heading: 'Today' },
  { key: 'week', label: '7 Days', heading: 'Last 7 Days' },
  { key: '30days', label: '30 Days', heading: 'Last 30 Days' },
  { key: 'month', label: 'Month', heading: 'This Month' },
  { key: 'all', label: '6 Months', heading: 'Last 6 Months' },
]

type Insight = 'forecast' | 'calendar' | 'stats'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat('en-US')
const money = (v: number) => usd.format(v)
const count = (v: number) => whole.format(Math.round(v))

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function Popover() {
  const [period, setPeriod] = useState<Period>('week')
  const [provider, setProvider] = useState('all')
  const [insight, setInsight] = useState<Insight>('forecast')

  // The "All" payload for the period always loads: its providerDetails feed the
  // pills even while a single provider is selected. For the standard tabs it is
  // a materialized index read, so this costs milliseconds.
  const all = useQuery({ queryKey: ['popover', period, 'all'], queryFn: () => fetchUsage(period, 'all') as Promise<PopoverPayload> })
  const scoped = useQuery({
    queryKey: ['popover', period, provider],
    queryFn: () => fetchUsage(period, provider) as Promise<PopoverPayload>,
    enabled: provider !== 'all',
  })
  const data = provider === 'all' ? all.data : scoped.data
  const loading = provider === 'all' ? all.isLoading : scoped.isLoading
  const history = all.data?.history.daily ?? []

  const heading = PERIOD_TABS.find(t => t.key === period)?.heading ?? ''
  const providers = (all.data?.current.providerDetails ?? []).filter(p => p.cost >= 0.005).sort((a, b) => b.cost - a.cost)
  const allCost = all.data?.current.cost ?? 0
  const stale = all.data?.stale === true

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-card text-card-foreground select-none">
      <header className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <div className="text-lg font-semibold tracking-tight">
            Code<span className="text-[#e8743b]">Burn</span>
          </div>
          <div className="text-xs text-tertiary-foreground">AI Coding Cost Tracker</div>
        </div>
        <span
          title={stale ? 'Figures are older than a few minutes; the index worker is refreshing' : 'Live'}
          className={cn('mt-1.5 h-3 w-3 rounded-full', stale ? 'bg-amber-500' : 'bg-primary')}
        />
      </header>

      <div className="border-y border-border px-3 py-2.5">
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
          <ProviderPill
            label="All"
            cost={allCost}
            share={1}
            active={provider === 'all'}
            onClick={() => setProvider('all')}
            primary
          />
          {providers.map(p => (
            <ProviderPill
              key={p.id}
              label={p.label || p.id}
              cost={p.cost}
              share={allCost > 0 ? p.cost / allCost : 0}
              active={provider === p.id}
              onClick={() => setProvider(p.id)}
            />
          ))}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto [scrollbar-width:thin]">
        <section className="px-5 pt-4 pb-3">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {heading}
            {provider !== 'all' && <span className="text-tertiary-foreground">· {providers.find(p => p.id === provider)?.label ?? provider}</span>}
          </div>
          <div className="mt-1 flex items-end justify-between">
            <div className={cn('font-mono text-4xl font-semibold tracking-tight text-primary tabular-nums', loading && 'opacity-40')}>
              {data ? money(data.current.cost) : '—'}
            </div>
            <div className="text-right font-mono text-xs tabular-nums">
              <div className="text-muted-foreground">{data ? `${count(data.current.calls)} calls` : ''}</div>
              <div className="text-tertiary-foreground">{data ? `${count(data.current.sessions)} sessions` : ''}</div>
            </div>
          </div>
        </section>

        <div className="px-4 pb-3">
          <Segmented
            items={PERIOD_TABS.map(t => ({ key: t.key, label: t.label }))}
            value={period}
            onChange={k => setPeriod(k as Period)}
          />
        </div>

        <div className="flex gap-1.5 px-4 pb-3">
          {(['forecast', 'calendar', 'stats'] as Insight[]).map(key => (
            <button
              key={key}
              type="button"
              onClick={() => setInsight(key)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
                insight === key ? 'bg-primary text-primary-foreground' : 'bg-interactive-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {key}
            </button>
          ))}
        </div>

        <section className="px-5 pb-4">
          {insight === 'forecast' && <ForecastPanel days={history} />}
          {insight === 'calendar' && <CalendarPanel days={history} />}
          {insight === 'stats' && <StatsPanel days={history} />}
        </section>

        <ActivityList payload={data} />
      </main>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => {
            void all.refetch()
            if (provider !== 'all') void scoped.refetch()
          }}
          className="rounded-md bg-interactive-secondary px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          ↻ Refresh
        </button>
        <a
          href={`./?period=${period}${provider !== 'all' ? `&provider=${provider}` : ''}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Full Report
        </a>
      </footer>
    </div>
  )
}

function ProviderPill(props: { label: string; cost: number; share: number; active: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-md px-3 pt-1 pb-1.5 text-left text-xs whitespace-nowrap transition-colors',
        props.active ? 'bg-primary text-primary-foreground' : 'bg-interactive-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="font-medium">{props.label}</span>{' '}
      <span className="font-mono tabular-nums">{money(props.cost)}</span>
      {!props.primary && (
        <span
          className={cn('absolute bottom-0 left-0 h-0.5', props.active ? 'bg-primary-foreground/60' : 'bg-primary')}
          style={{ width: `${Math.max(4, Math.min(100, props.share * 100))}%` }}
        />
      )}
    </button>
  )
}

function Segmented(props: { items: Array<{ key: string; label: string }>; value: string; onChange: (k: string) => void }) {
  return (
    <div className="flex rounded-md border border-border bg-interactive-secondary p-0.5">
      {props.items.map(item => (
        <button
          key={item.key}
          type="button"
          onClick={() => props.onChange(item.key)}
          className={cn(
            'flex-1 rounded-[5px] py-1 text-xs font-medium whitespace-nowrap transition-colors',
            props.value === item.key ? 'bg-active-primary text-foreground shadow-sm' : 'text-tertiary-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-tertiary-foreground">{props.label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums">{props.value}</div>
    </div>
  )
}

function ForecastPanel({ days }: { days: Payload['history']['daily'] }) {
  const f = useMemo(() => computeForecast(days), [days])
  const diff = f.previousMonth && f.previousMonth > 0 ? ((f.projection - f.previousMonth) / f.previousMonth) * 100 : null
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] text-tertiary-foreground">Month-to-date</div>
          <div className="font-mono text-2xl font-semibold text-primary tabular-nums">{money(f.monthToDate)}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-tertiary-foreground">On pace for</div>
          <div className="font-mono text-xl font-semibold tabular-nums">{money(f.projection)}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Avg/day (7d)" value={money(f.weekAvg)} />
        <Stat label="Yesterday" value={money(f.yesterday)} />
        <Stat label="Last 7d" value={money(f.last7)} />
      </div>
      <div className={cn('text-xs', diff === null ? 'text-tertiary-foreground' : diff >= 0 ? 'text-amber-500' : 'text-primary')}>
        {diff === null
          ? 'No prior month to compare'
          : `${diff >= 0 ? '↗ +' : '↘ '}${diff.toFixed(0)}% vs last month (${money(f.previousMonth!)})`}
      </div>
    </div>
  )
}

const LEVEL_CLASS = ['bg-interactive-secondary', 'bg-primary/25', 'bg-primary/45', 'bg-primary/70', 'bg-primary']

function CalendarPanel({ days }: { days: Payload['history']['daily'] }) {
  const weeks = useMemo(() => heatmapWeeks(days, 19), [days])
  const [hover, setHover] = useState<HeatCell | null>(null)
  const stats = useMemo(() => computeStats(weeks.flat()), [weeks])
  const rowLabel = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[11px] text-tertiary-foreground">Daily activity</div>
          <div className="font-mono text-2xl font-semibold tabular-nums">{money(stats.total)}</div>
        </div>
        <div className="text-xs text-primary">{stats.activeDays} active days</div>
      </div>
      <div className="flex gap-1.5">
        <div className="grid grid-rows-7 gap-[3px] pr-1 text-[9px] leading-[11px] text-tertiary-foreground">
          {rowLabel.map((l, i) => <span key={i}>{l}</span>)}
        </div>
        <div className="flex gap-[3px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-rows-7 gap-[3px]">
              {week.map(cell => (
                <div
                  key={cell.date}
                  onMouseEnter={() => setHover(cell)}
                  onMouseLeave={() => setHover(null)}
                  className={cn('h-[11px] w-[11px] rounded-[2px]', cell.future ? 'bg-transparent' : LEVEL_CLASS[cell.level])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between rounded-md bg-interactive-secondary px-3 py-2 text-xs">
        <span className="text-muted-foreground">{hover ? hover.date : 'Hover a day'}</span>
        <span className="font-mono tabular-nums">
          {hover ? `${money(hover.cost)} · ${count(hover.calls)} calls` : '—'}
        </span>
      </div>
    </div>
  )
}

function StatsPanel({ days }: { days: Payload['history']['daily'] }) {
  const stats = useMemo(() => computeStats(heatmapWeeks(days, 19).flat()), [days])
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-md bg-interactive-secondary p-2.5">
        <Stat label="Peak day" value={stats.peak ? money(stats.peak.cost) : '—'} />
        <div className="mt-0.5 text-[10px] text-tertiary-foreground">{stats.peak?.date ?? ''}</div>
      </div>
      <div className="rounded-md bg-interactive-secondary p-2.5">
        <Stat label="Avg active" value={money(stats.avgActive)} />
      </div>
      <div className="rounded-md bg-interactive-secondary p-2.5">
        <Stat label="Streak" value={`${stats.streak}d`} />
      </div>
    </div>
  )
}

function ActivityList({ payload }: { payload?: PopoverPayload }) {
  const rows = (payload?.current.topActivities ?? []).filter(a => a.cost >= 0.005)
  const max = rows.reduce((m, a) => Math.max(m, a.cost), 0)
  if (rows.length === 0) return null
  return (
    <section className="border-t border-border px-5 pt-3 pb-4">
      <div className="mb-2 grid grid-cols-[1fr_auto_3rem_3rem] items-center gap-3 text-[11px] text-tertiary-foreground">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-primary" />Activity</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Turns</span>
        <span className="text-right">1-shot</span>
      </div>
      <div className="space-y-1.5">
        {rows.map(a => (
          <div key={a.name} className="grid grid-cols-[1fr_auto_3rem_3rem] items-center gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-interactive-secondary">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(8, (a.cost / max) * 100)}%` }} />
              </span>
              <span className="truncate">{a.name}</span>
            </span>
            <span className="text-right font-mono tabular-nums">{money(a.cost)}</span>
            <span className="text-right font-mono text-muted-foreground tabular-nums">{count(a.turns)}</span>
            <span className="text-right font-mono text-muted-foreground tabular-nums">
              {a.oneShotRate === null ? '—' : `${Math.round(a.oneShotRate * 100)}%`}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
