import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/// The `origin` remote of a checkout, read straight from .git/config. Two clones
/// or worktrees of the same repository share it, which is what lets surfaces
/// fold a dozen throwaway checkouts into one project.

export function parseGitConfigSection(config: string, section: string, key: string): string | null {
  const wanted = `[${section.toLowerCase()}]`
  let inSection = false
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      inSection = line.toLowerCase() === wanted
      continue
    }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim().toLowerCase() !== key.toLowerCase()) continue
    return line.slice(eq + 1).trim()
  }
  return null
}

/** Comparable identity for a remote URL: `git@github.com:o/r.git` and
 *  `https://github.com/o/r` both become `github.com/o/r`. */
export function normalizeOriginUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?=[^/])/, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

function entryKind(path: string): 'file' | 'dir' | null {
  try {
    const st = statSync(path)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
  } catch {
    return null
  }
}

function resolveGitCommonDir(gitDir: string): string {
  const marker = join(gitDir, 'commondir')
  if (!existsSync(marker)) return gitDir
  const rel = readFileSync(marker, 'utf8').trim()
  if (!rel) return gitDir
  if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) return rel
  return join(gitDir, rel)
}

// Memoized per repo root: every session in the same repo would otherwise
// re-read .git/config. Process-lifetime only, so a remote URL change needs a
// restart (a resident `serve` child included).
const originByRoot = new Map<string, string | null>()

export function readGitOriginUrl(repoRoot: string): string | null {
  const memo = originByRoot.get(repoRoot)
  if (memo !== undefined) return memo
  const url = readGitOriginUrlUncached(repoRoot)
  originByRoot.set(repoRoot, url)
  return url
}

function readGitOriginUrlUncached(repoRoot: string): string | null {
  try {
    let gitDir = join(repoRoot, '.git')
    const kind = entryKind(gitDir)
    if (kind === 'file') {
      const match = readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
      if (!match?.[1]) return null
      gitDir = match[1].startsWith('/') || /^[a-zA-Z]:[\\/]/.test(match[1]) ? match[1] : join(repoRoot, match[1])
    } else if (kind !== 'dir') {
      return null
    }
    for (const configPath of [join(gitDir, 'config'), join(resolveGitCommonDir(gitDir), 'config')]) {
      if (!existsSync(configPath)) continue
      const url = parseGitConfigSection(readFileSync(configPath, 'utf8'), 'remote "origin"', 'url')
      if (url) return url
    }
    return null
  } catch {
    return null
  }
}

/** `readGitOriginUrl` normalized, or null when the checkout has no origin. */
export function gitOriginKey(repoRoot: string): string | null {
  const url = readGitOriginUrl(repoRoot)
  return url ? normalizeOriginUrl(url) : null
}

export function __resetGitOriginCache(): void {
  originByRoot.clear()
}
