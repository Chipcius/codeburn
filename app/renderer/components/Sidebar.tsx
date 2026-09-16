import { useEffect, useState, type ReactNode } from 'react'

import { codeburn } from '../lib/ipc'
import { isWindowsPlatform, shortcutLabel } from '../lib/platform'
import type { CompanionStatus } from '../lib/types'
import { AboutModal, SOCIALS } from './AboutModal'
import { FlameMark } from './FlameMark'
import { Icon } from './icons'

export type Section = 'overview' | 'sessions' | 'pullRequests' | 'spend' | 'optimize' | 'models' | 'compare' | 'periods' | 'plans' | 'settings' | 'plugins'

export const NAV_ITEMS: Array<{ id: Section; label: string; key: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', key: '1', icon: <Icon name="layout-dashboard" /> },
  { id: 'sessions', label: 'Sessions', key: '2', icon: <Icon name="list" /> },
  { id: 'pullRequests', label: 'Pull requests', key: '3', icon: <Icon name="git-pull-request" /> },
  { id: 'spend', label: 'Spend', key: '4', icon: <Icon name="coins" /> },
  { id: 'optimize', label: 'Optimize', key: '5', icon: <Icon name="sparkles" /> },
  { id: 'models', label: 'Models', key: '6', icon: <Icon name="box" /> },
  { id: 'compare', label: 'Compare', key: '7', icon: <Icon name="scale" /> },
  { id: 'plans', label: 'Plans', key: '8', icon: <Icon name="credit-card" /> },
  { id: 'periods', label: 'Compare periods', key: '9', icon: <Icon name="calendar-range" /> },
  { id: 'settings', label: 'Settings', key: ',', icon: <Icon name="settings" /> },
  { id: 'plugins', label: 'Plugins', key: '.', icon: <Icon name="puzzle" /> },
]

export function Sidebar({
  active,
  onNavigate,
}: {
  active: Section
  onNavigate: (section: Section) => void
  status?: ReactNode
}) {
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <>
      <nav className="sb">
        <div className="app"><FlameMark size={20} live /><b>CodeBurn</b></div>
        {NAV_ITEMS.map(item => (
          <div
            key={item.id}
            className={item.id === active ? 'ni on' : 'ni'}
            role="button"
            aria-current={item.id === active ? 'page' : undefined}
            tabIndex={0}
            onClick={() => onNavigate(item.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNavigate(item.id)
              }
            }}
          >
            {item.icon}
            {item.label}
            <span className="k">{shortcutLabel(item.key)}</span>
          </div>
        ))}
        <div className="push" />
        <CompanionSwitches />
        <div className="foot">
          <a className="about" href="#about" onClick={event => { event.preventDefault(); setAboutOpen(true) }}>About</a>
          <SocialGlyphs />
        </div>
      </nav>
      {aboutOpen ? <AboutModal onClose={() => setAboutOpen(false)} /> : null}
    </>
  )
}

/**
 * The row of brand glyphs in the corner, beside About.
 *
 * Windows is the one platform that gives that corner to something else: the two companion
 * switches sit above About, and a 186px sidebar has no room for both. Every other platform
 * keeps the glyphs it always had, since nothing replaced them there. About lists the same
 * links under Links on every platform.
 */
function SocialGlyphs() {
  if (isWindowsPlatform()) return null
  return (
    <div className="social">
      {SOCIALS.map(social => (
        <a
          key={social.label}
          href={social.url}
          title={social.label}
          aria-label={social.label}
          onClick={event => { event.preventDefault(); void codeburn.openExternal(social.url) }}
        >
          {social.icon}
        </a>
      ))}
    </div>
  )
}

/**
 * The two surfaces the Windows desktop app carries besides its own window: the tray app
 * ("Menu bar") and the Capacity Dock rail it draws ("Sidebar"). Both are on by default and
 * live above About, in the corner the social glyphs share on every other platform.
 *
 * Nothing renders until the main process says this build has a tray app staged, which is why
 * there is no placeholder row and no disabled switch: on macOS, on Linux, and in a dev build
 * with nothing staged, the corner is exactly what it always was.
 */
function CompanionSwitches() {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [busy, setBusy] = useState<'menuBar' | 'sidebar' | null>(null)

  useEffect(() => {
    let live = true
    // `codeburn` is the preload bridge, absent in a plain browser and under tests, and
    // `companionStatus` is absent on a preload that predates these two switches.
    void codeburn?.companionStatus?.()
      .then(next => { if (live) setStatus(next) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  if (!status?.supported) return null

  // Every setter answers with the whole status, so a switch shows what took rather than what
  // was asked for: an install the person cancelled at the UAC prompt leaves it where it was.
  const toggle = (key: 'menuBar' | 'sidebar') => {
    if (busy) return
    const call = key === 'menuBar' ? codeburn.setMenuBarEnabled : codeburn.setSidebarEnabled
    if (!call) return
    setBusy(key)
    void call.call(codeburn, !status[key])
      .then(setStatus)
      .catch(() => {})
      .finally(() => setBusy(null))
  }

  // The rail is a window of the tray app, and every setting it reads belongs to the tray app,
  // so there is no rail without one. With Menu bar off the Sidebar switch has nothing to
  // control and says so, rather than looking available and turning the tray app on underneath.
  const railBlocked = !status.menuBar

  const row = (key: 'menuBar' | 'sidebar', label: string, hint: string) => {
    const blocked = key === 'sidebar' && railBlocked
    const title = blocked ? 'The Capacity Dock needs the menu bar app' : hint
    return (
      <div className={blocked ? 'companion-row blocked' : 'companion-row'}>
        <span className="companion-label" title={title}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={status[key]}
          aria-label={label}
          title={title}
          disabled={busy !== null || blocked}
          className={status[key] ? 'switch sm on' : 'switch sm'}
          onClick={() => toggle(key)}
        >
          <span className="switch-knob" />
        </button>
      </div>
    )
  }

  return (
    <div className="companion">
      {row('menuBar', 'Menu bar', 'Show CodeBurn in the Windows notification area')}
      {row('sidebar', 'Sidebar', 'Show the Capacity Dock rail on the screen edge')}
      {/* Windows finishes an install it could not complete at the next restart, and until
          then the old tray app is what is on disk, so nothing was started. */}
      {status.restartRequired ? (
        <p className="companion-note">Restart Windows to finish installing the menu bar app.</p>
      ) : null}
    </div>
  )
}
