import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { callMoodle, launchUrl, parseLaunchToken } from './auth'

const SITE = 'https://moodle.example.ac.uk'
const TOKEN = 'a'.repeat(32)
const link = (signature: string, extra = '') =>
  `moodlemobile://token=${Buffer.from(`${signature}:::${TOKEN}${extra}`).toString('base64')}`
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

describe('Moodle sign-in', () => {
  it('builds the launch page for the Moodle app service', () => {
    const { url, passport } = launchUrl(SITE)
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe(`${SITE}/admin/tool/mobile/launch.php`)
    expect(u.searchParams.get('service')).toBe('moodle_mobile_app')
    expect(u.searchParams.get('urlscheme')).toBe('moodlemobile')
    expect(u.searchParams.get('passport')).toBe(passport)
    expect(launchUrl(SITE).passport).not.toBe(passport)
  })

  it('takes the key only when it was signed for this sign-in', () => {
    const passport = 'p123'
    expect(parseLaunchToken(link(md5(SITE + passport)), SITE, passport)).toEqual({
      token: TOKEN,
      privateToken: undefined
    })
    expect(
      parseLaunchToken(link(md5(SITE + passport), ':::private'), SITE, passport)?.privateToken
    ).toBe('private')
    // Another sign-in's passport, another site, or not the app link at all.
    expect(parseLaunchToken(link(md5(SITE + 'other')), SITE, passport)).toBeNull()
    expect(
      parseLaunchToken(link(md5('https://evil.example' + passport)), SITE, passport)
    ).toBeNull()
    expect(parseLaunchToken('https://moodle.example.ac.uk/', SITE, passport)).toBeNull()
  })

  it('sends the key in the request body and keeps it out of errors', async () => {
    let seen: { url: string; body: string } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) }
      return new Response(JSON.stringify({ exception: 'x', errorcode: 'invalidtoken' }))
    }) as unknown as typeof fetch
    await expect(
      callMoodle({ site: SITE, token: TOKEN }, 'core_webservice_get_site_info', {}, fake)
    ).rejects.toThrow(/Connect Moodle again/)
    expect(seen!.url).toBe(`${SITE}/webservice/rest/server.php`)
    expect(seen!.url).not.toContain(TOKEN)
    expect(seen!.body).toContain(`wstoken=${TOKEN}`)
    const blocked = (async () =>
      new Response('<title>Just a moment...</title>')) as unknown as typeof fetch
    await expect(callMoodle({ site: SITE, token: TOKEN }, 'f', {}, blocked)).rejects.toThrow(
      /bot check/
    )
  })
})
