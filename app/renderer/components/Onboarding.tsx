import { useState } from 'react'
import { createPortal } from 'react-dom'

import { FlameMark } from './FlameMark'
import { Icon } from './icons'
import { codeburn } from '../lib/ipc'
import { motionClass } from '../lib/motion'

const COLLECT_URL = 'https://www.codeburn.app/telemetry'

type Screen = {
  title: string
  body: string
  glyph: React.ReactNode
}

const SCREENS: Screen[] = [
  {
    title: 'Every agent. One dashboard.',
    body: 'Claude Code, Codex, Cursor, Copilot and 20+ more: spend, sessions, models and quotas, side by side.',
    glyph: <Icon name="layout-dashboard" className="onboard-mark" />,
  },
  {
    title: 'Local-first by design.',
    body: 'Usage is read from files already on your machine. No accounts, no API keys, nothing leaves your device.',
    glyph: <Icon name="lock" className="onboard-mark" />,
  },
  {
    title: 'Find the waste.',
    body: 'Retry tax, routing waste and task success by category: see what your agents actually deliver for the money.',
    glyph: <Icon name="search" className="onboard-mark" />,
  },
]

/**
 * First-launch overlay: three feature screens, then the telemetry consent
 * screen. The toggle's initial position comes from the region default (EU/EEA/
 * UK/CH off, elsewhere on) and nothing is transmitted until the user finishes
 * here. Rendered only while the main process reports `onboarded: false`.
 */
export function Onboarding({ defaultEnabled, onDone }: { defaultEnabled: boolean; onDone: (enabled: boolean) => void }) {
  const [step, setStep] = useState(0)
  const [enabled, setEnabled] = useState(defaultEnabled)
  const last = SCREENS.length // consent screen index
  const isConsent = step === last

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className={motionClass('onboard', 'onboard-in')} role="dialog" aria-label="Welcome to CodeBurn">
      <div className="onboard-card">
        <div className="onboard-glyph" aria-hidden>
          {isConsent
            ? <FlameMark size={40} />
            : SCREENS[step].glyph}
        </div>

        {isConsent ? (
          <>
            <h2 className="onboard-title">Help improve CodeBurn</h2>
            <p className="onboard-body">
              Share anonymous usage statistics: model and provider mix, task success rates, performance and errors.
              The daily report includes the names of the models, tools, skills and MCP servers you use, alongside
              bucketed counts of how often each one came up.
              Never your prompts, your code, or your project and file names.
            </p>
            <div className="onboard-consent">
              <span id="onboard-consent-label">Anonymous telemetry</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-labelledby="onboard-consent-label"
                className={enabled ? 'switch on' : 'switch'}
                onClick={() => setEnabled(value => !value)}
              >
                <span className="switch-knob" />
              </button>
            </div>
            <button type="button" className="onboard-link" onClick={() => { void codeburn.openExternal?.(COLLECT_URL) }}>
              What data we collect
            </button>
            <p className="onboard-hint">
              Tip: if a provider looks empty, grant Full Disk Access in System Settings › Privacy &amp; Security.
            </p>
          </>
        ) : (
          <>
            <h2 className="onboard-title">{SCREENS[step].title}</h2>
            <p className="onboard-body">{SCREENS[step].body}</p>
          </>
        )}

        <div className="onboard-controls">
          {step > 0 ? (
            <button type="button" className="onboard-btn" onClick={() => setStep(value => value - 1)}>Back</button>
          ) : <span className="onboard-btn-ghost" />}
          <div className="onboard-dots" aria-hidden>
            {[...SCREENS, null].map((_, index) => (
              <span key={index} className={index === step ? 'onboard-dot on' : 'onboard-dot'} />
            ))}
          </div>
          {isConsent ? (
            <button type="button" className="onboard-btn primary" onClick={() => onDone(enabled)}>Get started</button>
          ) : (
            <button type="button" className="onboard-btn primary" onClick={() => setStep(value => value + 1)}>Next</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
