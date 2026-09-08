// Load a ruleset document into a group.
//
//   pnpm rulesets:seed <org-slug>                        the Divot Diggers ruleset
//   pnpm rulesets:seed <org-slug> presets/standard-stableford.json
//
// Publishes it as the next version for that group, and attaches it to any event that has no
// rules yet.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { parseRuleset } from '@ddga/types';
import { loadEnv } from '../src/env.ts';

const [slug, file] = process.argv.slice(2);
if (slug === undefined) {
  console.error('Usage: pnpm rulesets:seed <org-slug> [file.json]');
  process.exit(1);
}

const path =
  file === undefined
    ? fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url))
    : resolve(file);

let document: unknown;
try {
  document = JSON.parse(readFileSync(path, 'utf8'));
  parseRuleset(document);
} catch (error) {
  console.error(`${path} is not a valid ruleset:\n  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const ruleset = parseRuleset(document);

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
    console.error(
      `No group with slug "${slug}". Available: ${all.rows.map((r) => r.slug).join(', ') || '(none)'}`,
    );
    process.exit(1);
  }

  const next = await client.query<{ next: number }>(
    'SELECT coalesce(max(version), 0) + 1 AS next FROM rulesets WHERE org_id = $1 AND key = $2',
    [orgId, ruleset.rulesetId],
  );
  const version = next.rows[0]?.next ?? 1;

  const created = await client.query<{ id: string }>(
    `INSERT INTO rulesets (org_id, key, name, version, document, published_at)
     VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
    [orgId, ruleset.rulesetId, ruleset.name, version, JSON.stringify(document)],
  );

  const attached = await client.query(
    `UPDATE events SET ruleset_id = $1
      WHERE org_id = $2 AND ruleset_id IS NULL AND ruleset_snapshot IS NULL`,
    [created.rows[0]?.id, orgId],
  );

  console.log(`Loaded "${ruleset.name}" v${version} into ${org.rows[0]?.name}.`);
  if ((attached.rowCount ?? 0) > 0) {
    console.log(`Attached it to ${attached.rowCount} event(s) that had no rules.`);
  }
} finally {
  client.release();
  await pool.end();
}
