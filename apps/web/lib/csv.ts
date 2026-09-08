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
