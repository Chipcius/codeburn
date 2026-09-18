import { useEffect, useRef, useState } from 'react'
import { codeburn } from '../lib/ipc'
import type { MacMenubarStatus } from '../lib/types'
import styles from './Plugins.module.css'

/** The menubar app and the desktop app already share the CLI, the cache and the config, so the
 *  card has no link step: install, open, and the one switch the app draws a window for. */
const POLL_MS = 4000

type Action = 'install' | 'open' | 'dock' | 'quit' | 'uninstall'

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

export function MenuBarCard() {
  const [status, apply, refresh] = useMacMenubarStatus()
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Quit and Uninstall confirm in the card, the same way removing a plugin does on this page.
  const [confirming, setConfirming] = useState<'quit' | 'uninstall' | null>(null)

  if (!status?.supported) return null

  const act = async (kind: Action, call: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await call()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
      setConfirming(null)
      refresh()
    }
  }

  const install = () => act('install', async () => {
    const result = await codeburn.macMenubarInstall?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not be installed.')
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
    const next = await codeburn.macMenubarQuit?.()
    if (next) apply(next)
  })

  const uninstall = () => act('uninstall', async () => {
    const result = await codeburn.macMenubarUninstall?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not be removed.')
  })

  return (
    <div className={styles.row} data-status="loaded">
      <div className={styles.info}>
        <div className={styles.name}>Menu bar</div>
        <div className={styles.reason}>
          CodeBurn in the macOS menu bar, with the Capacity Dock rail on the screen edge.
        </div>
        <div className={styles.caps}>
          {status.running && (
            <span className={styles.running}><span className={styles.runningDot} />Running</span>
          )}
          {status.version && <span>v{status.version}</span>}
        </div>
        {error && <div className={styles.cardError}>{error}</div>}
      </div>
      {status.installed && (
        <label className={styles.dockToggle}>
          <span>Capacity Dock</span>
          <button
            type="button"
            role="switch"
            aria-checked={status.dock}
            aria-label="Capacity Dock"
            disabled={busy !== null || !status.running}
            title={status.running ? 'Show the Capacity Dock rail on the screen edge' : 'Open the menu bar app to use the Capacity Dock'}
            className={status.dock ? 'switch sm on' : 'switch sm'}
            onClick={toggleDock}
          >
            <span className="switch-knob" />
          </button>
        </label>
      )}
      <div className={styles.actions}>
        {confirming ? (
          <>
            <span className={styles.confirm}>
              {confirming === 'quit' ? 'Quit the menu bar app?' : 'Remove the menu bar app?'}
            </span>
            <button
              className="btnp"
              onClick={confirming === 'quit' ? quit : uninstall}
              disabled={busy !== null}
            >
              {busy ? 'Working\u2026' : 'Yes'}
            </button>
            <button className="btnp" onClick={() => setConfirming(null)} disabled={busy !== null}>No</button>
          </>
        ) : status.installed ? (
          <>
            <button className="btnp" onClick={open} disabled={busy !== null}>
              {busy === 'open' ? 'Opening\u2026' : 'Open'}
            </button>
            {status.running && (
              <button className="btnp" onClick={() => setConfirming('quit')} disabled={busy !== null}>Quit</button>
            )}
            <button className="btnp" onClick={() => setConfirming('uninstall')} disabled={busy !== null}>Uninstall</button>
          </>
        ) : status.canInstall ? (
          <button className="btnp btnp-primary" onClick={install} disabled={busy !== null}>
            {busy === 'install' ? 'Installing\u2026' : 'Install'}
          </button>
        ) : (
          <span className={styles.website}>Get the menu bar from the website</span>
        )}
      </div>
    </div>
  )
}
