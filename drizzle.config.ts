import { defineConfig } from 'drizzle-kit'

// `npm run db:generate` turns schema changes into SQL migrations in ./drizzle.
// Migrations are applied at runtime by src/main/db/client.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './drizzle'
})
