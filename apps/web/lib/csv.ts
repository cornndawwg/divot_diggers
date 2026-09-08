/**
 * A small CSV reader, for pasting a roster out of a spreadsheet.
 *
 * Handles the two things that actually break naive splitting: a comma inside a quoted field
 * ("Cornwell, Shon") and a doubled quote inside one. Tabs are accepted as well as commas,
 * because pasting straight out of a spreadsheet gives tabs.
 */
export function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ',';

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field.trim());
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field.trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  row.push(field.trim());
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

export interface RosterRow {
  name: string;
  email?: string;
  phone?: string;
  handicapIndex?: number;
  startingPtp?: number;
}

export interface RosterParse {
  readonly rows: RosterRow[];
  /** Which column each field was read from, so the planner can see it guessed right. */
  readonly columns: Record<string, string>;
  readonly problems: string[];
}

/** Column names accepted for each field. Matching ignores case, spaces and punctuation. */
const HEADINGS: Record<keyof RosterRow, string[]> = {
  name: ['name', 'player', 'golfer', 'fullname', 'displayname'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'cell', 'phonenumber', 'telephone'],
  handicapIndex: ['handicap', 'handicapindex', 'index', 'hcp', 'hi'],
  startingPtp: ['ptp', 'startingptp', 'target', 'startingtarget', 'points', 'pointstopull'],
};

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Read a roster out of pasted text.
 *
 * A header row is used when one is recognised. Without one, the first column is taken as the
 * name and nothing else is assumed — guessing that the second column is a handicap rather
 * than a phone number would be worse than asking.
 */
export function parseRoster(text: string): RosterParse {
  const table = parseDelimited(text);
  const problems: string[] = [];
  if (table.length === 0) return { rows: [], columns: {}, problems: ['Nothing to read.'] };

  const header = table[0] ?? [];
  const mapping: Partial<Record<keyof RosterRow, number>> = {};
  const columns: Record<string, string> = {};

  header.forEach((cell, index) => {
    const key = normalise(cell);
    for (const [field, names] of Object.entries(HEADINGS) as [keyof RosterRow, string[]][]) {
      if (mapping[field] === undefined && names.includes(key)) {
        mapping[field] = index;
        columns[field] = cell;
      }
    }
  });

  const hasHeader = mapping.name !== undefined;
  if (!hasHeader) {
    mapping.name = 0;
    columns['name'] = 'first column';
    problems.push(
      'No header row recognised, so the first column is being read as the name and nothing else.',
    );
  }

  const body = hasHeader ? table.slice(1) : table;
  const rows: RosterRow[] = [];

  body.forEach((cells, position) => {
    const read = (field: keyof RosterRow): string => {
      const index = mapping[field];
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };

    const name = read('name');
    if (name === '') return;

    const row: RosterRow = { name };
    const email = read('email');
    const phone = read('phone');
    if (email !== '') row.email = email;
    if (phone !== '') row.phone = phone;

    for (const field of ['handicapIndex', 'startingPtp'] as const) {
      const raw = read(field);
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        problems.push(`Row ${position + 1} (${name}): "${raw}" is not a number.`);
        continue;
      }
      row[field] = value;
    }
    rows.push(row);
  });

  if (rows.length === 0) problems.push('No rows with a name in them.');
  return { rows, columns, problems };
}


// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

export interface ScorecardParse {
  /** One entry per tee set column found, in the order they appeared. */
  readonly teeSets: { name: string; yardages: (number | null)[] }[];
  readonly holes: { holeNumber: number; par: number; strokeIndex: number | null }[];
  readonly problems: string[];
}

const HOLE_NAMES = ['hole', 'holeno', 'holenumber', 'no', '#'];
const PAR_NAMES = ['par'];
const SI_NAMES = ['si', 'strokeindex', 'handicap', 'hcp', 'index', 'stroke'];

/**
 * Read a scorecard laid out the way a course prints one: a row per hole, with par and stroke
 * index in their own columns and one column per tee.
 *
 * Any column that is not hole, par or stroke index is taken to be a tee set named by its
 * heading — which is how the colours end up as tee names without anyone configuring anything.
 * Rows whose hole number is not a number (OUT, IN, TOTAL) are ignored, since those are the
 * printed subtotals rather than holes.
 */
export function parseScorecard(text: string): ScorecardParse {
  const table = parseDelimited(text);
  const problems: string[] = [];
  if (table.length < 2) {
    return { teeSets: [], holes: [], problems: ['Nothing to read.'] };
  }

  const header = table[0] ?? [];
  const keys = header.map(normalise);
  const holeAt = keys.findIndex((key) => HOLE_NAMES.includes(key));
  const parAt = keys.findIndex((key) => PAR_NAMES.includes(key));
  const siAt = keys.findIndex((key) => SI_NAMES.includes(key));

  if (holeAt === -1 || parAt === -1) {
    return {
      teeSets: [],
      holes: [],
      problems: ['The card needs a Hole column and a Par column.'],
    };
  }

  const teeColumns = header
    .map((label, index) => ({ label: label.trim(), index }))
    .filter((column) => ![holeAt, parAt, siAt].includes(column.index) && column.label !== '');

  const holes: ScorecardParse['holes'] = [];
  const yardages: (number | null)[][] = teeColumns.map(() => []);

  for (const cells of table.slice(1)) {
    const holeNumber = Number((cells[holeAt] ?? '').trim());
    if (!Number.isInteger(holeNumber) || holeNumber < 1) continue; // OUT / IN / TOTAL rows

    const par = Number((cells[parAt] ?? '').trim());
    if (!Number.isInteger(par)) {
      problems.push(`Hole ${holeNumber}: "${cells[parAt] ?? ''}" is not a par.`);
      continue;
    }

    const rawIndex = siAt === -1 ? '' : (cells[siAt] ?? '').trim();
    const strokeIndex = rawIndex === '' ? null : Number(rawIndex);
    if (strokeIndex !== null && !Number.isInteger(strokeIndex)) {
      problems.push(`Hole ${holeNumber}: "${rawIndex}" is not a stroke index.`);
    }

    holes.push({
      holeNumber,
      par,
      strokeIndex: strokeIndex !== null && Number.isInteger(strokeIndex) ? strokeIndex : null,
    });

    teeColumns.forEach((column, position) => {
      const raw = (cells[column.index] ?? '').trim().replace(/,/g, '');
      const value = raw === '' || raw === '-' ? null : Number(raw);
      yardages[position]?.push(Number.isFinite(value as number) ? (value as number) : null);
    });
  }

  if (holes.length === 0) problems.push('No hole rows found.');

  return {
    teeSets: teeColumns.map((column, position) => ({
      name: column.label,
      yardages: yardages[position] ?? [],
    })),
    holes,
    problems,
  };
}

/** Turn a parsed card into the course document the API accepts. */
export function scorecardToCourse(
  name: string,
  parsed: ScorecardParse,
): Record<string, unknown> {
  const usable = parsed.teeSets.filter((tee) => tee.yardages.some((value) => value !== null));
  const teeSets = (usable.length > 0 ? usable : [{ name: 'Default', yardages: [] }]).map((tee) => {
    const total = tee.yardages.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    return {
      name: tee.name,
      holes: parsed.holes.map((hole, index) => ({
        holeNumber: hole.holeNumber,
        par: hole.par,
        ...(hole.strokeIndex === null ? {} : { strokeIndex: hole.strokeIndex }),
        ...(tee.yardages[index] == null ? {} : { yardage: tee.yardages[index] }),
      })),
      parTotal: parsed.holes.reduce((sum, hole) => sum + hole.par, 0),
      ...(total > 0 ? { yardageTotal: total } : {}),
    };
  });

  return {
    course: { name, totalHoles: parsed.holes.length, source: 'manual' },
    teeSets,
  };
}
