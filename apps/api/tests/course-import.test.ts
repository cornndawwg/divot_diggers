import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { CourseImportRejected, importCourse } from '../src/courses/import.ts';
import { createAuthHarness, type AuthHarness } from './helpers/auth-harness.ts';

const SEED = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../seed/caledonia.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

let harness: AuthHarness;
let orgId = '';

beforeAll(async () => {
  harness = await createAuthHarness('ddga_courses');
  const org = await harness.privilegedPool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ('Divot Diggers','ddd') RETURNING id`,
  );
  orgId = org.rows[0]?.id ?? '';
}, 90_000);

afterAll(async () => {
  await harness?.destroy();
});

/** Run inside a transaction that is always rolled back, so tests cannot affect each other. */
async function inRollback<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await harness.privilegedPool.connect();
  try {
    await client.query('BEGIN');
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('importing the real Caledonia card', () => {
  it('writes one course, four tee sets and seventy-two holes', async () => {
    await inRollback(async (client) => {
      const outcome = await importCourse(client, orgId, null, SEED);
      expect(outcome.teeSetIds).toHaveLength(4);
      expect(outcome.holeCount).toBe(72); // 18 holes across 4 tee sets
      expect(outcome.validation.valid).toBe(true);
      expect(outcome.validation.errors).toEqual([]);

      const holes = await client.query<{ count: string }>(
        `SELECT count(*) FROM course_holes h
           JOIN tee_sets t ON t.id = h.tee_set_id
          WHERE t.course_id = $1`,
        [outcome.courseId],
      );
      expect(holes.rows[0]?.count).toBe('72');
    });
  });

  it('records the ratings and slopes from the card', async () => {
    await inRollback(async (client) => {
      const outcome = await importCourse(client, orgId, null, SEED);
      const { rows } = await client.query<{
        name: string;
        course_rating: string;
        slope_rating: number;
        par_total: number;
        yardage_total: number;
      }>(
        `SELECT name, course_rating, slope_rating, par_total, yardage_total
           FROM tee_sets WHERE course_id = $1 ORDER BY yardage_total DESC`,
        [outcome.courseId],
      );
      expect(rows.map((row) => [row.name, Number(row.course_rating), row.slope_rating])).toEqual([
        ['Pintail', 71.4, 144],
        ['Mallard', 69.3, 140],
        ['Wood Duck', 67.4, 128],
        ['Redhead', 63.6, 119],
      ]);
      expect(rows.every((row) => row.par_total === 70)).toBe(true);
    });
  });

  it('marks it verified, since the card was checked against the scan', async () => {
    await inRollback(async (client) => {
      const outcome = await importCourse(client, orgId, null, SEED);
      const { rows } = await client.query<{ completeness: string; source: string; provenance: string }>(
        'SELECT completeness, source, provenance FROM courses WHERE id = $1',
        [outcome.courseId],
      );
      expect(rows[0]?.completeness).toBe('verified');
      expect(rows[0]?.source).toBe('scorecard_import');
      // Owned, not licensed, so it could enter a shared library later.
      expect(rows[0]?.provenance).toBe('owned');
    });
  });

  it('keeps the stroke indexes attached to the right holes', async () => {
    await inRollback(async (client) => {
      const outcome = await importCourse(client, orgId, null, SEED);
      const { rows } = await client.query<{ hole_number: number; par: number; stroke_index: number }>(
        `SELECT h.hole_number, h.par, h.stroke_index
           FROM course_holes h JOIN tee_sets t ON t.id = h.tee_set_id
          WHERE t.course_id = $1 AND t.name = 'Pintail'
          ORDER BY h.hole_number`,
        [outcome.courseId],
      );
      expect(rows).toHaveLength(18);
      // Hole 16 is the hardest hole on the card.
      expect(rows.find((row) => row.hole_number === 16)?.stroke_index).toBe(1);
      // Hole 9 is the easiest.
      expect(rows.find((row) => row.hole_number === 9)?.stroke_index).toBe(18);
      expect(rows.reduce((sum, row) => sum + row.par, 0)).toBe(70);
    });
  });
});

describe('a corrupted card', () => {
  function withBadPar(): Record<string, unknown> {
    const copy = structuredClone(SEED) as {
      teeSets: { holes: { par: number }[] }[];
    };
    const hole = copy.teeSets[0]?.holes[0];
    if (hole === undefined) throw new Error('no hole');
    hole.par = 5; // was 4
    return copy as unknown as Record<string, unknown>;
  }

  it('is refused by the checksum suite', async () => {
    await inRollback(async (client) => {
      await expect(importCourse(client, orgId, null, withBadPar())).rejects.toThrow(
        CourseImportRejected,
      );
    });
  });

  it('says which check failed and by how much', async () => {
    await inRollback(async (client) => {
      try {
        await importCourse(client, orgId, null, withBadPar());
        throw new Error('the import should have been refused');
      } catch (error) {
        expect(error).toBeInstanceOf(CourseImportRejected);
        const rejection = error as CourseImportRejected;
        expect(rejection.validation.errors.map((entry) => entry.id)).toEqual(['par_totals']);
        expect(rejection.validation.errors[0]?.detail).toContain('add up to 71');
      }
    });
  });

  it('writes nothing at all', async () => {
    await inRollback(async (client) => {
      const before = await client.query<{ count: string }>('SELECT count(*) FROM courses');
      await importCourse(client, orgId, null, withBadPar()).catch(() => undefined);
      const after = await client.query<{ count: string }>('SELECT count(*) FROM courses');
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

      const teeSets = await client.query<{ count: string }>('SELECT count(*) FROM tee_sets');
      expect(teeSets.rows[0]?.count).toBe('0');
    });
  });
});

describe('a par-only course', () => {
  const parOnly = {
    course: { name: 'Parking Lot Muni', totalHoles: 9, source: 'manual' },
    teeSets: [
      {
        name: 'Default',
        holes: [4, 3, 5, 4, 4, 3, 4, 5, 4].map((par, index) => ({
          holeNumber: index + 1,
          par,
        })),
      },
    ],
  };

  it('imports with nothing but pars', async () => {
    await inRollback(async (client) => {
      const outcome = await importCourse(client, orgId, null, parOnly);
      expect(outcome.holeCount).toBe(9);
      expect(outcome.validation.valid).toBe(true);

      const { rows } = await client.query<{ completeness: string; total_holes: number }>(
        'SELECT completeness, total_holes FROM courses WHERE id = $1',
        [outcome.courseId],
      );
      // 'par_only' is a playable state, not a broken one.
      expect(rows[0]?.completeness).toBe('par_only');
      expect(rows[0]?.total_holes).toBe(9);
    });
  });

  it('leaves stroke index and yardage null, to be backfilled later', async () => {
    await inRollback(async (client) => {
      const outcome = await importCourse(client, orgId, null, parOnly);
      const { rows } = await client.query<{ stroke_index: number | null; yardage: number | null }>(
        `SELECT h.stroke_index, h.yardage FROM course_holes h
           JOIN tee_sets t ON t.id = h.tee_set_id WHERE t.course_id = $1`,
        [outcome.courseId],
      );
      expect(rows.every((row) => row.stroke_index === null)).toBe(true);
      expect(rows.every((row) => row.yardage === null)).toBe(true);
    });
  });
});

describe('the database backstops the validator', () => {
  it('refuses a licensed course with no provider, even if validation let it through', async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO courses (org_id, name, total_holes, provenance) VALUES ($1,'X',18,'licensed')`,
          [orgId],
        ),
      ).rejects.toThrow(/licensed_rows_need_provider/);
    });
  });
});
