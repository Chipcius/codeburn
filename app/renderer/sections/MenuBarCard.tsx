import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AnchoredSurface } from '../components/AnchoredSurface'
import { Icon } from '../components/icons'
import { useEscape } from '../hooks/useEscape'
import { codeburn } from '../lib/ipc'
import type { MacMenubarStatus } from '../lib/types'
import { MenuBarAboutModal } from './MenuBarAbout'
import styles from './Plugins.module.css'
import menubarArt from '../assets/menubar-card-art.jpg'
import menubarArtLight from '../assets/menubar-card-art-light.jpg'

/** The menubar app and the desktop app already share the CLI, the cache and the config, so the
 *  card has no link step: install, open, and the one switch the app draws a window for. */
const POLL_MS = 4000

type Action = 'install' | 'open' | 'dock' | 'quit' | 'uninstall' | 'update' | 'settings'

/**
 * Polls only while this card is mounted (the Plugins page unmounts on navigation) and only
 * while the window is showing, so a backgrounded app costs nothing. No global timer, and the
 * poll never sets state to a value equal to the one held, so a still machine re-renders zero
 * times (PR 1352).
 */
function useMacMenubarStatus(): [MacMenubarStatus | null, (next: MacMenubarStatus) => void, () => void] {
  const [status, setStatus] = useState<MacMenubarStatus | null>(null)
  const held = useRef<string>('')

  const apply = (next: MacMenubarStatus) => {
    const key = JSON.stringify(next)
    if (key === held.current) return
    held.current = key
    setStatus(next)
  }

  const refresh = () => {
    void codeburn?.macMenubarStatus?.().then(apply).catch(() => {})
  }

  useEffect(() => {
    let live = true
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void codeburn?.macMenubarStatus?.().then(next => { if (live) apply(next) }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { live = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [status, apply, refresh]
}

export function MenuBarCard({ art = menubarArt, artLight = menubarArtLight }: { art?: string; artLight?: string } = {}) {
  const [status, apply, refresh] = useMacMenubarStatus()
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Quit and Uninstall confirm in the card, the same way removing a plugin does on this page.
  const [confirming, setConfirming] = useState<'quit' | 'uninstall' | null>(null)
  // What the install is doing right now, from the CLI's own narration. An install takes about
  // half a minute, most of it an 8 MB download, and a button that only says "Installing…" for
  // that long reads as a hang.
  const [phase, setPhase] = useState<string | null>(null)
  const [about, setAbout] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEscape(menuOpen, () => setMenuOpen(false))

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!moreRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  if (!status?.supported) return null

  /** Exactly one button carries the emphasis, and which one depends on the state. */
  const primary = status.outdated && status.canInstall ? 'update'
    : !status.installed ? 'install'
    : status.running ? 'settings'
    : 'open'

  const act = async (kind: Action, call: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    setPhase(null)
    try {
      await call()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
      setPhase(null)
      setConfirming(null)
      setMenuOpen(false)
      refresh()
    }
  }

  const runInstall = (kind: 'install' | 'update') => act(kind, async () => {
    const stop = codeburn.onMacMenubarProgress?.(setPhase)
    try {
      const result = await codeburn.macMenubarInstall?.()
      if (!result) return
      // What landed decides the card, so a release older than this build can drive still comes
      // back as the outdated state rather than a cheerful Running.
      apply(result.status)
      if (!result.ok) setError(result.error ?? 'The menu bar app could not be installed.')
    } finally {
      stop?.()
    }
  })

  const install = () => runInstall('install')

  const update = () => runInstall('update')

  const settings = () => act('settings', async () => {
    const result = await codeburn.macMenubarSettings?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not open its settings.')
  })

  const open = () => act('open', async () => {
    const next = await codeburn.macMenubarOpen?.()
    if (next) apply(next)
  })

  const toggleDock = () => act('dock', async () => {
    const next = await codeburn.macMenubarSetDock?.(!status.dock)
    if (next) apply(next)
  })

  const quit = () => act('quit', async () => {
    const result = await codeburn.macMenubarQuit?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not be quit.')
  })

  const uninstall = () => act('uninstall', async () => {
    const result = await codeburn.macMenubarUninstall?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not be removed.')
  })

  return (
    <div
      className={`${styles.row} ${styles.art}`}
      style={{
        '--card-art': `url(${art})`,
        '--card-art-light': `url(${artLight})`,
        // The light wordmark was drawn near-black; this holds it back to roughly the
        // contrast the dark art gives it, without flattening the apricot haze behind it.
        '--art-light-wash': .84,
      } as CSSProperties}
      data-status="loaded"
    >
      <div className={styles.info}>
        <div className={styles.nameRow}>
          <div className={styles.name}>Menu bar</div>
          <button
            type="button"
            className={`ov-info ${styles.infoDot}`}
            aria-label="What the menu bar app does"
            onClick={() => setAbout(true)}
          >
            <Icon name="info" />
          </button>
        </div>
        <div className={styles.reason}>
          CodeBurn in the macOS menu bar, with the Capacity Dock rail on the screen edge.
        </div>
        <div className={styles.caps}>
          {status.running && (
            <span className={styles.running}><span className={styles.runningDot} />Running</span>
          )}
          {status.version && <span>v{status.version}</span>}
        </div>
        {/* One note row, always present, so the card is the same height in every state. An
            error answers something the person just pressed, so it wins over the hint. */}
        <div className={styles.note} data-kind={error ? 'error' : 'hint'} title={error ?? undefined}>
          {error ?? (status.outdated ? 'Update the menu bar to use this' : '')}
        </div>
      </div>
      <div className={styles.controls}>
        {status.installed && (
          <label className={styles.dockToggle}>
            <span>Capacity Dock</span>
            <button
              type="button"
              role="switch"
              aria-checked={status.dock}
              aria-label="Capacity Dock"
              disabled={busy !== null || !status.running || status.outdated}
              title={status.outdated
                ? 'Update the menu bar to use this'
                : status.running ? 'Show the Capacity Dock rail on the screen edge' : 'Open the menu bar app to use the Capacity Dock'}
              className={status.dock ? 'switch sm on' : 'switch sm'}
              onClick={toggleDock}
            >
              <span className="switch-knob" />
            </button>
          </label>
        )}
        <div className={styles.actions}>
          {status.installed ? (
            <>
              <button
                className={primary === 'settings' ? `btnp ${styles.primary}` : 'btnp'}
                onClick={settings}
                disabled={busy !== null || status.outdated}
                title={status.outdated ? 'Update the menu bar to use this' : "Open the menu bar app's own Settings window"}
              >
                {busy === 'settings' ? 'Opening\u2026' : 'Settings'}
              </button>
              {/* Nothing to bring forward while it is up: the menubar is its own status item,
                  and Settings is the only window it has. */}
              {!status.running && (
                <button
                  className={primary === 'open' ? `btnp ${styles.primary}` : 'btnp'}
                  onClick={open}
                  disabled={busy !== null}
                >
                  {busy === 'open' ? 'Opening\u2026' : 'Open'}
                </button>
              )}
              {status.outdated && status.canInstall && (
                <button className={`btnp ${styles.primary}`} onClick={update} disabled={busy !== null}>
                  {busy === 'update' ? `${phase ?? 'Updating'}\u2026` : 'Update'}
                </button>
              )}
              {/* Quit and Uninstall live behind the dots so a mis-click next to Open cannot
                  take the app away. Their confirm rows stay inside the menu. */}
              <button
                ref={moreRef}
                type="button"
                className={`btnp ${styles.more}`}
                aria-label="More menu bar actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={busy !== null}
                onClick={() => setMenuOpen(value => !value)}
              >
                <Icon name="ellipsis" />
              </button>
              {menuOpen && (
                <AnchoredSurface anchor={moreRef} surfaceRef={menuRef} className={`pop-menu ${styles.menu}`} role="menu" aria-label="More menu bar actions">
                  {confirming ? (
                    <div className="pop-confirm">
                      <span>{confirming === 'quit' ? 'Quit the menu bar app?' : 'Remove the menu bar app?'}</span>
                      <button type="button" className="danger" onClick={confirming === 'quit' ? quit : uninstall} disabled={busy !== null}>
                        {busy ? 'Working\u2026' : 'Yes'}
                      </button>
                      <button type="button" onClick={() => setConfirming(null)} disabled={busy !== null}>No</button>
                    </div>
                  ) : (
                    <>
                      {status.running && (
                        <button
                          type="button"
                          role="menuitem"
                          className="pop-item"
                          disabled={busy !== null || status.outdated}
                          title={status.outdated ? 'Update the menu bar to use this' : undefined}
                          onClick={() => setConfirming('quit')}
                        >
                          Quit
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="pop-item danger"
                        disabled={busy !== null || status.outdated}
                        title={status.outdated ? 'Update the menu bar to use this' : undefined}
                        onClick={() => setConfirming('uninstall')}
                      >
                        Uninstall
                      </button>
                    </>
                  )}
                </AnchoredSurface>
              )}
            </>
          ) : status.canInstall ? (
            <button className={`btnp ${styles.primary}`} onClick={install} disabled={busy !== null}>
              {busy === 'install' ? `${phase ?? 'Installing'}\u2026` : 'Install'}
            </button>
          ) : (
            <span className={styles.website}>Get the menu bar from the website</span>
          )}
        </div>
      </div>
      {about && <MenuBarAboutModal onClose={() => setAbout(false)} />}
    </div>
  )
}
