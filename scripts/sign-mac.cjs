// electron-builder's mac.sign hook (electron-builder.yml): signs Engram in a few codesign calls
// instead of one per file (osx-sign made about 740 calls, half a minute per build).
//
// Engram is signed with the self-signed "Engram Local" certificate for this Mac only (docs/ORIGINAL-SPEC.md
// §9), so there's no secure timestamp (that's for notarised apps). The loose programs in
// app.asar.unpacked (the Agent SDK's `claude` binary, better-sqlite3's native module) are signed
// first, because --deep only signs nested bundles and frameworks. Then the whole app is signed
// with --deep, which signs Electron's framework and helper apps from the inside out and seals
// everything else. Every piece gets the same entitlements, as before (entitlementsInherit).
// CommonJS because electron-builder require()s its hooks.
/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('child_process')
const { closeSync, openSync, readdirSync, readSync, statSync } = require('fs')
const { join } = require('path')

const ENTITLEMENTS = join(__dirname, '..', 'build', 'entitlements.mac.plist')
const MACH_O = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

function isMachO(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && MACH_O.has(head.readUInt32BE(0))
  } finally {
    closeSync(fd)
  }
}

function filesIn(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const s = statSync(path)
    return s.isDirectory() ? filesIn(path) : s.isFile() && s.size >= 4 ? [path] : []
  })
}

module.exports = async function signMac(opts) {
  const identity = typeof opts.identity === 'string' ? opts.identity : opts.identity?.hash
  if (!identity) throw new Error('No signing identity (mac.identity in electron-builder.yml).')
  const codesign = (...args) =>
    execFileSync('codesign', [
      '--sign',
      identity,
      '--force',
      '--timestamp=none',
      '--options',
      'runtime',
      '--entitlements',
      ENTITLEMENTS,
      ...args
    ])
  const unpacked = join(opts.app, 'Contents', 'Resources', 'app.asar.unpacked')
  for (const file of filesIn(unpacked).filter(isMachO)) codesign(file)
  codesign('--deep', opts.app)
}
