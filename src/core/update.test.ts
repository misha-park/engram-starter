import { describe, expect, it } from 'vitest'
import {
  buildLabel,
  bundleOf,
  MAX_NOTES,
  notesFromLog,
  parseBuildInfo,
  parseNotes,
  sameBuild,
  type BuildInfo
} from './update'

const build = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '1.0.0',
  commit: 'a1b2c3d4e5f6a7b8c9d0',
  dirty: false,
  builtAt: '2026-11-19T18:00:00.000Z',
  ...over
})

describe('parseBuildInfo', () => {
  it('reads a build.json', () => {
    expect(parseBuildInfo(JSON.stringify(build({ dirty: true })))).toEqual(build({ dirty: true }))
  })
  it('treats a missing dirty flag as clean', () => {
    const text = JSON.stringify({ ...build(), dirty: undefined })
    expect(parseBuildInfo(text)?.dirty).toBe(false)
  })
  it('rejects anything else', () => {
    expect(parseBuildInfo('not json')).toBeNull()
    expect(parseBuildInfo('{"version":"1.0.0"}')).toBeNull()
  })
})

describe('sameBuild', () => {
  it('needs the same commit and build time', () => {
    expect(sameBuild(build(), build())).toBe(true)
    expect(sameBuild(build(), build({ builtAt: '2026-11-19T18:05:00.000Z' }))).toBe(false)
    expect(sameBuild(build(), build({ commit: 'ffff' }))).toBe(false)
  })
  it('is false when either is unknown', () => {
    expect(sameBuild(null, build())).toBe(false)
    expect(sameBuild(build(), null)).toBe(false)
  })
})

describe('notes', () => {
  it('lists commit subjects, newest first, capped', () => {
    const log = Array.from({ length: MAX_NOTES + 4 }, (_, i) => `Change ${i}`).join('\n')
    const notes = notesFromLog(`${log}\n\n`)
    expect(notes.changes).toHaveLength(MAX_NOTES)
    expect(notes.changes[0]).toBe('Change 0')
    expect(notes.more).toBe(4)
  })
  it('is empty for an empty log', () => {
    expect(notesFromLog('')).toEqual({ changes: [], more: 0 })
  })
  it('parses notes.json leniently', () => {
    expect(parseNotes('{"changes":["A",3,"B"],"more":2}')).toEqual({ changes: ['A', 'B'], more: 2 })
    expect(parseNotes('')).toEqual({ changes: [], more: 0 })
  })
})

describe('bundleOf', () => {
  it('finds the .app an executable is in', () => {
    expect(bundleOf('/Applications/Engram.app/Contents/MacOS/Engram')).toBe(
      '/Applications/Engram.app'
    )
    expect(bundleOf('/tmp/a b/Engram.app/Contents/MacOS/Engram')).toBe('/tmp/a b/Engram.app')
  })
  it('is null outside a bundle (npm run dev)', () => {
    expect(bundleOf('/repo/node_modules/electron/dist/Electron')).toBeNull()
  })
})

it('labels a build', () => {
  expect(buildLabel(build())).toBe('1.0.0 · a1b2c3d')
  expect(buildLabel(build({ dirty: true }))).toBe('1.0.0 · a1b2c3d + uncommitted changes')
})
