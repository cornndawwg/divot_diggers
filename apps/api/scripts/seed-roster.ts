// Load a roster CSV into an event.
//
//   pnpm roster:seed <org-slug> <csv-file> [event-name]
//
// Uses the same importer the console uses. Without an event name it takes the group's only
// event, and refuses if there is more than one rather than guessing.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { parseRuleset, type IndividualTargetCompetition } from '@ddga/types';
import { importRosterRows, type RosterImportRow } from '../src/roster/import.ts';
import { loadEnv } from '../src/env.ts';

const [slug, file, eventName] = process.argv.slice(2);
if (slug === undefined || file === undefined) {
  console.error('Usage: pnpm roster:seed <org-slug> <csv-file> [event-name]');
  process.exit(1);
}

/** The same reader the console uses, kept simple enough to duplicate honestly. */
function parseCsv(text: string): RosterImportRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',').map((cell) => cell.trim().toLowerCase());
  const at = (names: string[]): number => header.findIndex((cell) => names.includes(cell));
  const columns = {
    name: at(['name', 'player', 'golfer']),
    email: at(['email']),
    phone: at(['phone', 'mobile']),
    handicapIndex: at(['handicap', 'hcp', 'index']),
    startingPtp: at(['ptp', 'target', 'starting ptp']),
  };
  if (columns.name === -1) {
    console.error('The CSV needs a Name column.');
    process.exit(1);
  }

  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const read = (index: number): string => (index === -1 ? '' : (cells[index] ?? ''));
    const number = (index: number): number | undefined => {
      const raw = read(index);
      if (raw === '') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    return {
      name: read(columns.name),
      email: read(columns.email) || undefined,
      phone: read(columns.phone) || undefined,
      handicapIndex: number(columns.handicapIndex),
      startingPtp: number(columns.startingPtp),
    };
  });
}

const rows = parseCsv(readFileSync(resolve(file), 'utf8'));
const pool = new Pool({ connectionString: loadEnv().databaseUrl });
const client = await pool.connect();
try {
  const org = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE slug = $1',
    [slug],
  );
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) {
    console.error(`No group with slug "${slug}".`);
    process.exit(1);
  }

  // add_org_person checks who is asking, so the script has to say. It acts as the group's
  // owner, which is who would be doing this in the console.
  const owner = await client.query<{ person_id: string }>(
    `SELECT person_id FROM org_members
      WHERE org_id = $1 AND removed_at IS NULL AND role = 'owner'
      ORDER BY joined_at LIMIT 1`,
    [orgId],
  );
  const ownerId = owner.rows[0]?.person_id;
  if (ownerId === undefined) {
    console.error('That group has no owner, so there is nobody to act as.');
    process.exit(1);
  }
  await client.query('SELECT set_config($1, $2, false)', ['app.person_id', ownerId]);

  const events = await client.query<{ id: string; name: string; document: unknown }>(
    `SELECT e.id, e.name, coalesce(e.ruleset_snapshot, r.document) AS document
       FROM events e LEFT JOIN rulesets r ON r.id = e.ruleset_id
      WHERE e.org_id = $1 AND ($2::text IS NULL OR e.name = $2)`,
    [orgId, eventName ?? null],
  );
  if (events.rows.length === 0) {
    console.error('No matching event.');
    process.exit(1);
  }
  if (events.rows.length > 1) {
    console.error(
      `That group has ${events.rows.length} events. Name one: ${events.rows.map((r) => `"${r.name}"`).join(', ')}`,
    );
    process.exit(1);
  }

  const event = events.rows[0];
  if (event === undefined || event.document === null) {
    console.error('That event has no rules attached, so there is no target to seed from.');
    process.exit(1);
  }
  const competition = parseRuleset(event.document).competitions.find(
    (entry): entry is IndividualTargetCompetition => entry.type === 'individual_target',
  );
  if (competition === undefined) {
    console.error('That event has no individual competition in its rules.');
    process.exit(1);
  }

  await client.query('BEGIN');
  const outcome = await importRosterRows(client, orgId, event.id, competition.target, rows);
  await client.query('COMMIT');

  for (const row of outcome) console.log(`  ${row.status.padEnd(9)} ${row.name}`);
  console.log(
    `\n${outcome.filter((row) => row.status === 'added').length} of ${outcome.length} added to "${event.name}".`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
