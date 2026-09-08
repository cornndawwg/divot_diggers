// Import a course document into a named organization.
//
//   pnpm courses:import-for <org-slug> <file.json>
//
// Same validate-then-write pipeline the API uses, so a card that does not add up is refused.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { CourseImportRejected, importCourse } from '../src/courses/import.ts';
import { loadEnv } from '../src/env.ts';

const [slug, file] = process.argv.slice(2);
if (slug === undefined || file === undefined) {
  console.error('Usage: pnpm courses:import-for <org-slug> <file.json>');
  process.exit(1);
}

const raw: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'));
const pool = new Pool({ connectionString: loadEnv().databaseUrl });
const client = await pool.connect();
try {
  const org = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE slug = $1',
    [slug],
  );
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) {
    console.error(`No organization with slug "${slug}".`);
    process.exit(1);
  }

  await client.query('BEGIN');
  const outcome = await importCourse(client, orgId, null, raw);
  await client.query('COMMIT');
  console.log(
    `Imported into ${org.rows[0]?.name}: ${outcome.teeSetIds.length} tee set(s), ${outcome.holeCount} holes.`,
  );
  console.log(outcome.validation.summary);
} catch (error) {
  await client.query('ROLLBACK');
  if (error instanceof CourseImportRejected) {
    console.error('Refused by the checksum suite; nothing was written.');
    for (const failure of error.validation.errors) {
      console.error(`  ${failure.label}: ${failure.detail ?? ''}`);
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
