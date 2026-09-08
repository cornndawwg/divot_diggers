// Load every course seed file into a group.
//
//   pnpm courses:seed <org-slug>
//
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { CourseImportRejected, importCourse } from '../src/courses/import.ts';
import { loadEnv } from '../src/env.ts';

const slug = process.argv[2];
if (slug === undefined) {
  console.error('Usage: pnpm courses:seed <org-slug>');
  process.exit(1);
}

const seedDir = fileURLToPath(new URL('../../../seed', import.meta.url));
const files = readdirSync(seedDir).filter((name) => name.endsWith('.json')).sort();

const pool = new Pool({ connectionString: loadEnv().databaseUrl });
const client = await pool.connect();
try {
  const org = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE slug = $1',
    [slug],
  );
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) {
    const all = await client.query<{ slug: string }>('SELECT slug FROM organizations ORDER BY slug');
    console.error(`No group with slug "${slug}". Available: ${all.rows.map((r) => r.slug).join(', ') || '(none)'}`);
    process.exit(1);
  }

  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(`${seedDir}/${file}`, 'utf8'));
    try {
      await client.query('BEGIN');
      const outcome = await importCourse(client, orgId, null, raw, { onDuplicateName: 'skip' });
      await client.query('COMMIT');
      console.log(
        outcome.alreadyPresent
          ? `  ${file}: already loaded, left alone`
          : `  ${file}: ${outcome.teeSetIds.length} tee sets, ${outcome.holeCount} holes`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof CourseImportRejected) {
        console.error(`  ${file}: refused by the checksum suite`);
      } else {
        console.error(`  ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  console.log(`\nLoaded into ${org.rows[0]?.name}.`);
} finally {
  client.release();
  await pool.end();
}
