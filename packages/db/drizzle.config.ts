import { defineConfig } from 'drizzle-kit';

// Migrations are plain SQL under ./migrations and are the source of truth for the
// schema (see CLAUDE.md's stack table). drizzle-kit is used only to introspect a
// migrated database, so the TypeScript schema can be checked against it rather
// than hand-maintained.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './.drizzle-introspect',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
