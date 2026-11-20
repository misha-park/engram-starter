// Small git helpers for the build scripts (build-info.ts, release.ts).
import { execFileSync } from 'child_process'
import { resolve } from 'path'

export const ROOT = resolve(import.meta.dirname, '..')

export function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/**
 * Files with uncommitted changes. docs/ORIGINAL-SPEC.md is left out: it holds the user's own notes and is
 * never committed by Claude, so it never counts as unfinished work.
 */
export function uncommittedFiles(): string[] {
  // Not git(): its trim() would eat the first line's leading space (" M docs/ORIGINAL-SPEC.md"), and the
  // status columns are fixed width. -z keeps paths with spaces unquoted.
  const out = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=normal'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  const files: string[] = []
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    files.push(entry.slice(3))
    // A rename or copy is followed by its old path, which isn't a separate change.
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return files.filter((file) => file !== 'docs/ORIGINAL-SPEC.md')
}
