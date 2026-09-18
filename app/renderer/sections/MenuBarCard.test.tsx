// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { MacMenubarStatus } from '../lib/types'

const bridge = vi.hoisted(() => ({
  macMenubarStatus: vi.fn(),
  macMenubarInstall: vi.fn(),
  macMenubarOpen: vi.fn(),
  macMenubarSetDock: vi.fn(),
  macMenubarQuit: vi.fn(),
  macMenubarUninstall: vi.fn(),
  pluginList: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ codeburn: bridge, normalizeCliError: (err: unknown) => err }))

const { MenuBarCard } = await import('./MenuBarCard')
const { PluginsSection } = await import('./Plugins')

function status(patch: Partial<MacMenubarStatus> = {}): MacMenubarStatus {
  return {
    supported: true, canInstall: true, installed: false,
    path: null, version: null, running: false, dock: false, ...patch,
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  delete (window as unknown as { codeburn?: unknown }).codeburn
  vi.clearAllMocks()
})

describe('MenuBarCard states', () => {
  it('not installed: offers Install and no version, dot or switch', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy())
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('installed but not running: Open plus the version, switch disabled', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, path: '/Applications/CodeBurnMenubar.app', version: '0.9.18' }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy())
    expect(screen.getByText('v0.9.18')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  })

  it('running: the green dot, the version and a live Capacity Dock switch', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true, dock: true }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy())
    const dock = screen.getByRole('switch')
    expect(dock.getAttribute('aria-checked')).toBe('true')
    expect(dock).toHaveProperty('disabled', false)
  })

  it('App Store build: the website line instead of an Install button', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ canInstall: false }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByText('Get the menu bar from the website')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('renders nothing when the main process says the platform is not supported', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ supported: false, canInstall: false }))
    const { container } = render(<MenuBarCard />)
    await waitFor(() => expect(bridge.macMenubarStatus).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})

describe('MenuBarCard actions', () => {
  it('installs and shows what came back, not what it asked for', async () => {
    // The poll is the authority, so it moves with the install rather than lagging it.
    let current = status()
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarInstall.mockImplementation(async () => {
      current = status({ installed: true, version: '1.0.0', running: true })
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy())
    expect(screen.getByText('v1.0.0')).toBeTruthy()
  })

  it('shows a failed install in plain words and keeps the Install button', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status())
    bridge.macMenubarInstall.mockResolvedValue({
      ok: false, error: 'No connection to github.com. Try again when you are back online.', status: status(),
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(screen.getByText('No connection to github.com. Try again when you are back online.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('Open asks the main process to open, which focuses a copy already up', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    bridge.macMenubarOpen.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(bridge.macMenubarOpen).toHaveBeenCalledTimes(1)
  })

  it('the switch sends the opposite of what is showing and renders the answer', async () => {
    let current = status({ installed: true, running: true, dock: false })
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarSetDock.mockImplementation(async (enabled: boolean) => {
      current = status({ installed: true, running: true, dock: enabled })
      return current
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('switch'))
    expect(bridge.macMenubarSetDock).toHaveBeenCalledWith(true)
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  })

  it('polls while mounted and stops when the card goes away', async () => {
    vi.useFakeTimers()
    bridge.macMenubarStatus.mockResolvedValue(status())
    const view = render(<MenuBarCard />)
    await vi.advanceTimersByTimeAsync(9000)
    const polled = bridge.macMenubarStatus.mock.calls.length
    expect(polled).toBeGreaterThan(1)
    view.unmount()
    await vi.advanceTimersByTimeAsync(20000)
    expect(bridge.macMenubarStatus.mock.calls.length).toBe(polled)
    vi.useRealTimers()
  })

  it('does not re-render on a poll that says the same thing', async () => {
    vi.useFakeTimers()
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0' }))
    render(<MenuBarCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const before = screen.getByText('v1.0.0')
    // Three more polls, all answering the same thing: the node is the very same node.
    await act(async () => { await vi.advanceTimersByTimeAsync(13000) })
    expect(screen.getByText('v1.0.0')).toBe(before)
    vi.useRealTimers()
  })
})

describe('MenuBarCard quit and uninstall', () => {
  it('running: Open, Quit and Uninstall; not running: no Quit', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    const view = render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quit' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
    view.unmount()

    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: false }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()
  })

  it('Quit confirms in the card and only then quits', async () => {
    let current = status({ installed: true, version: '1.0.0', running: true })
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarQuit.mockImplementation(async () => {
      current = status({ installed: true, version: '1.0.0', running: false })
      return current
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Quit' }))
    expect(bridge.macMenubarQuit).not.toHaveBeenCalled()
    expect(screen.getByText('Quit the menu bar app?')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(bridge.macMenubarQuit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Running')).toBeNull())
  })

  it('No backs out of a confirmation without doing anything', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    await userEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(bridge.macMenubarUninstall).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
  })

  it('Uninstall returns the card to Not installed', async () => {
    let current = status({ installed: true, version: '1.0.0', running: true })
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarUninstall.mockImplementation(async () => {
      current = status()
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy())
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('a failed uninstall says so in plain words and leaves the card as it is', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    bridge.macMenubarUninstall.mockResolvedValue({
      ok: false,
      error: 'CodeBurn could not remove the menu bar app. Check its permissions in Finder.',
      status: status({ installed: true, version: '1.0.0', running: true }),
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(screen.getByText('CodeBurn could not remove the menu bar app. Check its permissions in Finder.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
  })
})

describe('the Plugins page', () => {
  it('renders the card on darwin', async () => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'darwin' }
    bridge.pluginList.mockResolvedValue([])
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<PluginsSection />)
    await waitFor(() => expect(screen.getByText('Menu bar')).toBeTruthy())
  })

  it('renders no card on linux', async () => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'linux' }
    bridge.pluginList.mockResolvedValue([])
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<PluginsSection />)
    await waitFor(() => expect(screen.getByText('Coming soon')).toBeTruthy())
    expect(screen.queryByText('Menu bar')).toBeNull()
    expect(bridge.macMenubarStatus).not.toHaveBeenCalled()
  })

  it('renders no card on win32, where the page is its own coming-soon panel', async () => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'win32' }
    bridge.pluginList.mockResolvedValue([])
    render(<PluginsSection />)
    await waitFor(() => expect(screen.getByText('Plugins are coming to Windows')).toBeTruthy())
    expect(screen.queryByText('Menu bar')).toBeNull()
    expect(bridge.macMenubarStatus).not.toHaveBeenCalled()
  })
})
