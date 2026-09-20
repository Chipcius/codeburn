import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { installPageHiddenClass } from './lib/pageVisibility'
// Bundled so the UI renders in the same faces on every OS instead of the platform's system
// font (SF Pro on macOS, Segoe UI on Windows). Loaded before the stylesheets that reference
// them through --sans / --mono.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/indigo.css'
import './styles/plain.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// Pause looping CSS animations while the window is hidden/minimized (energy).
installPageHiddenClass()

// Tag the platform so CSS can adapt native chrome (macOS hiddenInset insets +
// drag regions); harmless when the bridge is absent (tests/jsdom).
document.documentElement.dataset.platform =
  (window as unknown as { codeburn?: { platform?: string } }).codeburn?.platform ?? ''

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
