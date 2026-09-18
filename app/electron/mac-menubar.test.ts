import { describe, expect, it, vi } from 'vitest'

import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DOCK_ENABLED_KEY, MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY, MacMenubar, installErrorMessage } from './mac-menubar'

const HOME = '/Users/tester'
const USER_APP = `${HOME}/Applications/CodeBurnMenubar.app`
const SYSTEM_APP = '/Applications/CodeBurnMenubar.app'

type RunCall = [string, string[]]

function harness(opts: {
  platform?: string
  mas?: boolean
  present?: string[]
  running?: boolean
  version?: string
  dock?: string | null
  mdfind?: string
  cli?: { ok: boolean; stdout?: string; stderr?: string }
  /** False for a menubar too old to watch the key, which only the signal can stop. */
  honoursRemoteCommand?: boolean
} = {}) {
  const present = new Set(opts.present ?? [])
  let running = Boolean(opts.running)
  const calls: RunCall[] = []
  const cliCalls: string[][] = []
  const run = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, args])
    if (command.endsWith('mdfind')) return opts.mdfind ?? ''
    if (command.endsWith('PlistBuddy')) return opts.version ?? '1.2.3'
    if (command.endsWith('pgrep')) return running ? '4242' : null
    if (command.endsWith('pkill')) { running = false; return '' }
    if (command.endsWith('defaults') && args[0] === 'read') return opts.dock ?? null
    if (command.endsWith('defaults') && args[0] === 'write') {
      if (args[2] === REMOTE_COMMAND_KEY && opts.honoursRemoteCommand !== false) running = false
      return ''
    }
    if (command.endsWith('defaults') && args[0] === 'delete') return ''
    if (command.endsWith('open')) return ''
    return null
  })
  const runCli = vi.fn(async (args: string[]) => {
    cliCalls.push(args)
    const cli = opts.cli ?? { ok: true }
    if (cli.ok) present.add(USER_APP)
    return { ok: cli.ok, stdout: cli.stdout ?? '', stderr: cli.stderr ?? '', code: cli.ok ? 0 : 1 }
  })
  let clock = 0
  const menubar = new MacMenubar({
    platform: opts.platform ?? 'darwin',
    mas: opts.mas ?? false,
    home: HOME,
    run,
    runCli,
    exists: (path: string) => present.has(path),
    // Each read advances a second, so the five-second polite wait is crossed in five polls.
    now: () => (clock += 1000),
  })
  return { menubar, calls, cliCalls, present, run, runCli, isRunning: () => running }
}

describe('MacMenubar.status', () => {
  it('reports unsupported off darwin without spawning anything', async () => {
    const { menubar, run } = harness({ platform: 'win32' })
    expect(await menubar.status()).toMatchObject({ supported: false, installed: false, canInstall: false })
    expect(run).not.toHaveBeenCalled()
  })

  it('is supported and installable on darwin with nothing installed', async () => {
    const { menubar } = harness()
    expect(await menubar.status()).toMatchObject({
      supported: true, canInstall: true, installed: false, path: null, version: null, running: false, dock: false,
    })
  })

  it('finds the bundle in ~/Applications', async () => {
    const { menubar } = harness({ present: [USER_APP], version: '0.9.18' })
    expect(await menubar.status()).toMatchObject({ installed: true, path: USER_APP, version: '0.9.18', running: false })
  })

  it('finds the bundle in /Applications', async () => {
    const { menubar } = harness({ present: [SYSTEM_APP] })
    expect(await menubar.status()).toMatchObject({ installed: true, path: SYSTEM_APP })
  })

  it('falls back to mdfind for a bundle somewhere else', async () => {
    const elsewhere = `${HOME}/Tools/CodeBurnMenubar.app`
    const { menubar, calls } = harness({ present: [elsewhere], mdfind: `${elsewhere}\n` })
    expect(await menubar.status()).toMatchObject({ installed: true, path: elsewhere })
    expect(calls.some(([cmd, args]) => cmd.endsWith('mdfind') && args[0].includes(MENUBAR_BUNDLE_ID))).toBe(true)
  })

  it('ignores an mdfind hit that is no longer on disk', async () => {
    const { menubar } = harness({ mdfind: '/gone/CodeBurnMenubar.app\n' })
    expect(await menubar.status()).toMatchObject({ installed: false, path: null })
  })

  it('matches the running process on the bundle it found, not the name', async () => {
    const { menubar, calls } = harness({ present: [SYSTEM_APP], running: true })
    expect(await menubar.status()).toMatchObject({ running: true })
    const pgrep = calls.find(([cmd]) => cmd.endsWith('pgrep'))
    expect(pgrep?.[1][1]).toBe(`${SYSTEM_APP}/Contents/MacOS/CodeBurnMenubar`)
  })

  it('reads the Capacity Dock switch from the menubar bundle id domain', async () => {
    const { menubar, calls } = harness({ present: [USER_APP], dock: '1' })
    expect(await menubar.status()).toMatchObject({ dock: true })
    const read = calls.find(([cmd, args]) => cmd.endsWith('defaults') && args[0] === 'read')
    expect(read?.[1]).toEqual(['read', MENUBAR_BUNDLE_ID, DOCK_ENABLED_KEY])
  })

  it('treats a missing defaults key as off', async () => {
    const { menubar } = harness({ present: [USER_APP], dock: null })
    expect(await menubar.status()).toMatchObject({ dock: false })
  })

  it('turns the Install button off in a Mac App Store build', async () => {
    const { menubar } = harness({ mas: true })
    expect(await menubar.status()).toMatchObject({ supported: true, canInstall: false })
  })
})

describe('MacMenubar.install', () => {
  it('runs the CLI installer without --force for a first install', async () => {
    const { menubar, cliCalls } = harness()
    const result = await menubar.install()
    expect(cliCalls).toEqual([['menubar']])
    expect(result).toMatchObject({ ok: true, error: null })
    expect(result.status.installed).toBe(true)
  })

  it('passes --force when a copy is already there, so a reinstall really reinstalls', async () => {
    const { menubar, cliCalls } = harness({ present: [USER_APP] })
    await menubar.install()
    expect(cliCalls).toEqual([['menubar', '--force']])
  })

  it('never downloads in a Mac App Store build', async () => {
    const { menubar, cliCalls } = harness({ mas: true })
    const result = await menubar.install()
    expect(cliCalls).toEqual([])
    expect(result).toMatchObject({ ok: false, error: 'Get the menu bar app from the website.' })
  })

  it('reports a failed install in plain words and leaves the status as found', async () => {
    const { menubar } = harness({ cli: { ok: false, stderr: 'Menubar install failed: fetch failed' } })
    const result = await menubar.install()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('No connection to github.com. Try again when you are back online.')
    expect(result.status.installed).toBe(false)
  })

  it('fails when the CLI exited 0 but nothing landed', async () => {
    const menubar = new MacMenubar({
      platform: 'darwin', mas: false, home: HOME,
      exists: () => false,
      run: async () => null,
      runCli: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    })
    const result = await menubar.install()
    expect(result.ok).toBe(false)
  })
})

describe('MacMenubar.open and setDockEnabled', () => {
  it('opens the bundle it found', async () => {
    const { menubar, calls } = harness({ present: [USER_APP] })
    await menubar.open()
    expect(calls.some(([cmd, args]) => cmd.endsWith('open') && args[0] === USER_APP)).toBe(true)
  })

  it('opens nothing when nothing is installed', async () => {
    const { menubar, calls } = harness()
    await menubar.open()
    expect(calls.some(([cmd]) => cmd.endsWith('open'))).toBe(false)
  })

  it('writes the dock switch as a bool into the menubar domain', async () => {
    const { menubar, calls } = harness({ present: [USER_APP] })
    await menubar.setDockEnabled(true)
    const write = calls.find(([cmd, args]) => cmd.endsWith('defaults') && args[0] === 'write')
    expect(write?.[1]).toEqual(['write', MENUBAR_BUNDLE_ID, DOCK_ENABLED_KEY, '-bool', 'true'])
    await menubar.setDockEnabled(false)
    const off = calls.filter(([cmd, args]) => cmd.endsWith('defaults') && args[0] === 'write').at(-1)
    expect(off?.[1].at(-1)).toBe('false')
  })
})

describe('installErrorMessage', () => {
  const cases: Array<[string, string]> = [
    ['getaddrinfo ENOTFOUND github.com', 'No connection to github.com. Try again when you are back online.'],
    ['No CodeBurnMenubar versioned zip found in release mac-v9.9.9.', 'The menu bar app has not been published for this CodeBurn version yet.'],
    ['Download failed: 404 Not Found', 'The menu bar app has not been published for this CodeBurn version yet.'],
    ['Checksum mismatch for CodeBurnMenubar-v1.0.0.zip', 'The download was damaged and was not installed. Try again.'],
    ['Archive did not contain CodeBurnMenubar.app.', 'The download was damaged and was not installed. Try again.'],
    ['mv: EACCES: permission denied', 'CodeBurn could not write to your Applications folder.'],
    ['The menubar app needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn',
      'The menu bar app needs the codeburn command on your PATH. Install it with: npm install -g codeburn'],
  ]
  it.each(cases)('maps %s', (stderr, expected) => {
    expect(installErrorMessage({ stdout: '', stderr })).toBe(expected)
  })

  it('falls back to the first line and never a stack frame', () => {
    const stderr = 'Menubar install failed: something odd\n    at foo (/x/y.js:1:1)\n    at bar (/x/y.js:2:2)'
    expect(installErrorMessage({ stdout: '', stderr })).toBe('something odd')
  })

  it('has a plain sentence when the CLI said nothing at all', () => {
    expect(installErrorMessage({ stdout: '', stderr: '' })).toBe('The menu bar app could not be installed.')
  })
})

describe('MacMenubar.quit', () => {
  it('asks the menubar to quit itself and does not signal when it does', async () => {
    const { menubar, calls, isRunning } = harness({ present: [USER_APP], running: true })
    const status = await menubar.quit()
    const write = calls.find(([cmd, args]) => cmd.endsWith('defaults') && args[0] === 'write' && args[2] === REMOTE_COMMAND_KEY)
    expect(write?.[1]).toEqual(['write', MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY, '-string', 'quit'])
    expect(calls.some(([cmd]) => cmd.endsWith('pkill'))).toBe(false)
    expect(isRunning()).toBe(false)
    expect(status.running).toBe(false)
    expect(status.installed).toBe(true)
  })

  it('signals a menubar too old to watch the key, and clears the command it left behind', async () => {
    const { menubar, calls, isRunning } = harness({ present: [USER_APP], running: true, honoursRemoteCommand: false })
    await menubar.quit()
    const kill = calls.find(([cmd]) => cmd.endsWith('pkill'))
    expect(kill?.[1][1]).toBe(`${USER_APP}/Contents/MacOS/CodeBurnMenubar`)
    expect(isRunning()).toBe(false)
    expect(calls.some(([cmd, args]) => cmd.endsWith('defaults') && args[0] === 'delete' && args[2] === REMOTE_COMMAND_KEY)).toBe(true)
  })

  it('does nothing when nothing is installed', async () => {
    const { menubar, calls } = harness()
    await menubar.quit()
    expect(calls.some(([cmd]) => cmd.endsWith('pkill') || cmd.endsWith('defaults') && cmd.includes('write'))).toBe(false)
  })
})

describe('MacMenubar.uninstall', () => {
  function onDisk() {
    const root = mkdtempSync(join(tmpdir(), 'mac-menubar-test-'))
    const bundle = join(root, 'Applications', 'CodeBurnMenubar.app', 'Contents', 'MacOS')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'CodeBurnMenubar'), '')
    return { root, app: join(root, 'Applications', 'CodeBurnMenubar.app') }
  }

  it('asks it to go, takes the bundle away, and leaves the card on Not installed', async () => {
    const { root, app } = onDisk()
    const calls: RunCall[] = []
    let running = true
    const menubar = new MacMenubar({
      platform: 'darwin', mas: false, home: root, now: (() => { let t = 0; return () => (t += 1000) })(),
      run: async (command, args) => {
        calls.push([command, args])
        if (command.endsWith('pgrep')) return running ? '1' : null
        if (command.endsWith('defaults') && args[0] === 'write' && args[2] === REMOTE_COMMAND_KEY) { running = false; return '' }
        if (command.endsWith('PlistBuddy')) return '1.0.0'
        return ''
      },
    })
    expect((await menubar.status()).installed).toBe(true)
    const result = await menubar.uninstall()
    expect(result.ok).toBe(true)
    expect(existsSync(app)).toBe(false)
    expect(result.status.installed).toBe(false)
    expect(result.status.running).toBe(false)
    // "uninstall" rather than "quit": the login item is the app's own to drop.
    const write = calls.find(([cmd, args]) => args[2] === REMOTE_COMMAND_KEY)
    expect(write?.[1].at(-1)).toBe('uninstall')
  })

  it('removes a copy Spotlight found outside either Applications folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mac-menubar-test-'))
    const moved = join(root, 'Tools', 'CodeBurnMenubar.app')
    mkdirSync(moved, { recursive: true })
    const menubar = new MacMenubar({
      platform: 'darwin', mas: false, home: join(root, 'empty'), now: (() => { let t = 0; return () => (t += 1000) })(),
      run: async (command) => {
        if (command.endsWith('mdfind')) return `${moved}\n`
        if (command.endsWith('pgrep')) return null
        if (command.endsWith('PlistBuddy')) return '1.0.0'
        return ''
      },
    })
    const result = await menubar.uninstall()
    expect(result.ok).toBe(true)
    expect(existsSync(moved)).toBe(false)
  })

  it('refuses to delete a path that is not a CodeBurnMenubar.app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mac-menubar-test-'))
    const impostor = join(root, 'Documents')
    mkdirSync(`${impostor}.app`, { recursive: true })
    const menubar = new MacMenubar({
      platform: 'darwin', mas: false, home: join(root, 'empty'),
      run: async (command) => {
        if (command.endsWith('mdfind')) return `${impostor}.app\n`
        return null
      },
      // Only the Spotlight answer is on disk; neither Applications folder has anything.
      exists: (path: string) => path === `${impostor}.app`,
    })
    const result = await menubar.uninstall()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('CodeBurn could not find the menu bar app to remove.')
    expect(existsSync(`${impostor}.app`)).toBe(true)
  })

  it('is a no-op that reports success when there is nothing installed', async () => {
    const { menubar } = harness()
    const result = await menubar.uninstall()
    expect(result).toMatchObject({ ok: true, error: null })
    expect(result.status.installed).toBe(false)
  })
})
