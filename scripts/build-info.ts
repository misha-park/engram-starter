// Writes out/build.json (version, commit, build time), which electron-builder packages as
// Contents/Resources/build.json. The app shows it in Settings → Updates, and the release script
// reads the installed app's copy to tell what's new. Run by `npm run package`.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BuildInfo } from '../src/core/update'
import { git, ROOT, uncommittedFiles } from './git'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
const info: BuildInfo = {
  version: pkg.version,
  commit: git('rev-parse', 'HEAD'),
  dirty: uncommittedFiles().length > 0,
  builtAt: new Date().toISOString()
}
mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(join(ROOT, 'out', 'build.json'), JSON.stringify(info, null, 2) + '\n')
console.log(
  `Build ${info.version} · ${info.commit.slice(0, 7)}${info.dirty ? ' (uncommitted changes)' : ''}`
)
