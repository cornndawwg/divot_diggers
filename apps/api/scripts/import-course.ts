// Imports a course document into the development database.
//
//   pnpm courses:import seed/caledonia.json
//   pnpm courses:import seed/caledonia.json --dry-run
//
// Runs the same validate-then-write pipeline the API uses, so a card that fails the checksum
// suite is refused here exactly as it would be in the console.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { courseDocumentSchema, validateCourseDocument } from '@ddga/types';
import { CourseImportRejected, importCourse } from '../src/courses/import.ts';
import { loadEnv } from '../src/env.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((arg) => !arg.startsWith('--'));

if (file === undefined) {
  console.error('Usage: pnpm courses:import <file.json> [--dry-run]');
  process.exit(1);
}

const raw: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'));

function report(): boolean {
  const parsed = courseDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`${file} is not a course document:\n`);
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return false;
  }

  const validation = validateCourseDocument(parsed.data);
  const icon = { pass: ' ok ', warning: 'CHECK', error: 'FAIL', skipped: ' -- ' };

  let lastTeeSet: string | null | undefined;
  for (const check of validation.checks) {
    if (check.teeSet !== lastTeeSet) {
      console.log(`\n${check.teeSet ?? 'across tee sets'}`);
      lastTeeSet = check.teeSet;
    }
    console.log(`  [${icon[check.status]}] ${check.label}`);
    if (check.detail !== undefined && check.status !== 'pass') {
      console.log(`           ${check.detail}`);
    }
  }

  console.log();
  console.log(validation.summary);
  return validation.valid;
}

const ok = report();

if (dryRun) {
  console.log('\nDry run: nothing was written.');
  process.exit(ok ? 0 : 1);
}

if (!ok) {
  console.error('\nRefused: fix the failures above, or correct the card.');
  process.exit(1);
}

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const client = await pool.connect();
try {
  const org = await client.query<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) {
    console.error(
      '\nNo organization exists yet, and a course has to belong to one.\n' +
        'Create an event roster first, or run this after task 2.6.',
    );
    process.exit(1);
  }

  await client.query('BEGIN');
  const outcome = await importCourse(client, orgId, null, raw);
  await client.query('COMMIT');
  console.log(
    `\nImported: course ${outcome.courseId}, ${outcome.teeSetIds.length} tee sets, ${outcome.holeCount} holes.`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  if (error instanceof CourseImportRejected) {
    console.error('\nRefused by the checksum suite; nothing was written.');
  } else {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
