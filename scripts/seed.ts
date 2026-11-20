// `npm run seed`: wipe and regenerate `npm run dev`'s demo profile from the command line.
// Always targets the demo profile (whatever profile the app has active) and never touches real data.
// If the app is open, prefer Settings → Reset demo data, or reload the app afterwards.
import { resolve } from 'path'
import { AppContext } from '../src/main/app-context'
import { devUserDataDir } from '../src/main/profile'

const demo = new AppContext(devUserDataDir(), resolve(import.meta.dirname, '../drizzle'), {
  profile: 'demo'
})
const summary = demo.resetDemo()
demo.close()
console.log('Demo data regenerated:', summary)
