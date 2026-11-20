// Run after electron-builder (see the `package` script): makes sure the built app has a valid
// signature. With no signing certificate set up, electron-builder leaves Electron's own signature
// broken by our changes, and macOS (and `npm run release`) would refuse the app. In that case we
// sign it "ad hoc" (a signature that needs no certificate; fine for an app used on the Mac that
// built it). If a real certificate already signed it, this does nothing.
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('child_process')
const { join } = require('path')
const signMac = require('./sign-mac.cjs')

const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const app = join(__dirname, '..', 'dist', arch, 'Engram.app')
const valid = spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status === 0
if (valid) {
  console.log('The app is already signed.')
} else {
  console.log('No certificate signed the app: signing it ad hoc.')
  signMac({ identity: '-', app }).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
