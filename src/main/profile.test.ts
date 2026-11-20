import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { assertDemo, profilePaths, readActiveProfile, writeActiveProfile } from './profile'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'planner-profile-'))

describe('profiles', () => {
  it('gives demo and real completely separate directories', () => {
    const dir = tmp()
    const demo = profilePaths(dir, 'demo')
    const real = profilePaths(dir, 'real')
    expect(demo.dbPath).not.toBe(real.dbPath)
    expect(demo.recordsDir).not.toBe(real.recordsDir)
    expect(real.dbPath.startsWith(demo.dir)).toBe(false)
    expect(demo.dbPath.startsWith(real.dir)).toBe(false)
  })

  it('defaults to demo and remembers a switch', () => {
    const dir = tmp()
    expect(readActiveProfile(dir)).toBe('demo')
    writeActiveProfile(dir, 'real')
    expect(readActiveProfile(dir)).toBe('real')
  })

  it('falls back to demo when profile.json is corrupt or unknown', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'profile.json'), '{nope')
    expect(readActiveProfile(dir)).toBe('demo')
    writeFileSync(join(dir, 'profile.json'), '{"active":"other"}')
    expect(readActiveProfile(dir)).toBe('demo')
  })

  it('assertDemo refuses the real profile', () => {
    const dir = tmp()
    expect(() => assertDemo(profilePaths(dir, 'demo'))).not.toThrow()
    expect(() => assertDemo(profilePaths(dir, 'real'))).toThrow(/Refusing/)
    // A path that claims to be demo but points elsewhere is refused too.
    expect(() => assertDemo({ ...profilePaths(dir, 'real'), name: 'demo' })).toThrow(/Refusing/)
  })
})
