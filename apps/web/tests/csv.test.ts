import { describe, expect, it } from 'vitest';
import { parseDelimited, parseRoster, parseScorecard, scorecardToCourse } from '../lib/csv';

describe('reading delimited text', () => {
  it('reads plain commas', () => {
    expect(parseDelimited('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps a comma inside quotes', () => {
    expect(parseDelimited('name,note\n"Cornwell, Shon",fine')).toEqual([
      ['name', 'note'],
      ['Cornwell, Shon', 'fine'],
    ]);
  });

  it('handles a doubled quote', () => {
    expect(parseDelimited('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('takes tabs, which is what pasting from a spreadsheet gives', () => {
    expect(parseDelimited('name\temail\nKenny\tk@x.com')).toEqual([
      ['name', 'email'],
      ['Kenny', 'k@x.com'],
    ]);
  });

  it('ignores blank lines and carriage returns', () => {
    expect(parseDelimited('a,b\r\n\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('reading a roster', () => {
  it('maps a header row whatever it is called', () => {
    const parsed = parseRoster(
      'Player,Email Address,Mobile,HCP,Starting PTP\nKenny Adkins,k@x.com,555,38,14',
    );
    expect(parsed.rows).toEqual([
      { name: 'Kenny Adkins', email: 'k@x.com', phone: '555', handicapIndex: 38, startingPtp: 14 },
    ]);
    expect(parsed.problems).toEqual([]);
  });

  it('does not care what order the columns are in', () => {
    const parsed = parseRoster('PTP,Name\n16,Shay Shamburger');
    expect(parsed.rows[0]).toEqual({ name: 'Shay Shamburger', startingPtp: 16 });
  });

  it('takes just names', () => {
    const parsed = parseRoster('Name\nMike Sinkule\nLee Butler');
    expect(parsed.rows.map((row) => row.name)).toEqual(['Mike Sinkule', 'Lee Butler']);
  });

  it('says so when it cannot recognise a header, rather than guessing', () => {
    // Guessing that column two is a handicap rather than a phone number would be worse
    // than asking, so only the first column is read.
    const parsed = parseRoster('Kenny Adkins,38\nLee Butler,20');
    expect(parsed.rows).toEqual([{ name: 'Kenny Adkins' }, { name: 'Lee Butler' }]);
    expect(parsed.problems[0]).toMatch(/No header row recognised/);
  });

  it('reports a number it cannot read, and keeps the rest of the row', () => {
    const parsed = parseRoster('Name,Handicap\nKenny Adkins,about twenty');
    expect(parsed.rows).toEqual([{ name: 'Kenny Adkins' }]);
    expect(parsed.problems[0]).toMatch(/"about twenty" is not a number/);
  });

  it('skips rows with no name', () => {
    const parsed = parseRoster('Name,PTP\nKenny,14\n,20\nLee,34');
    expect(parsed.rows.map((row) => row.name)).toEqual(['Kenny', 'Lee']);
  });

  it('handles an empty paste without throwing', () => {
    expect(parseRoster('').rows).toEqual([]);
    expect(parseRoster('   ').rows).toEqual([]);
  });

  it('reports which column each field came from', () => {
    const parsed = parseRoster('Golfer,HI\nKenny,38');
    expect(parsed.columns).toEqual({ name: 'Golfer', handicapIndex: 'HI' });
  });
});

describe('reading a printed scorecard', () => {
  const CARD = [
    'Hole,Par,SI,Blue,White,Green',
    '1,4,3,449,414,374',
    '2,4,11,349,323,292',
    '3,3,7,211,195,187',
    'OUT,11,,1009,932,853',
    '4,5,5,539,509,435',
    'TOTAL,16,,1548,1441,1288',
  ].join('\n');

  it('reads a row per hole', () => {
    const parsed = parseScorecard(CARD);
    expect(parsed.holes).toEqual([
      { holeNumber: 1, par: 4, strokeIndex: 3 },
      { holeNumber: 2, par: 4, strokeIndex: 11 },
      { holeNumber: 3, par: 3, strokeIndex: 7 },
      { holeNumber: 4, par: 5, strokeIndex: 5 },
    ]);
  });

  it('ignores the printed subtotal rows', () => {
    // OUT and TOTAL are not holes, and taking them as holes would corrupt every par.
    expect(parseScorecard(CARD).holes.map((hole) => hole.holeNumber)).toEqual([1, 2, 3, 4]);
  });

  it('takes every other column as a tee set named by its heading', () => {
    const parsed = parseScorecard(CARD);
    expect(parsed.teeSets.map((tee) => tee.name)).toEqual(['Blue', 'White', 'Green']);
    expect(parsed.teeSets[0]?.yardages).toEqual([449, 349, 211, 539]);
  });

  it('treats a dash as no yardage, which is how a card prints an unused tee', () => {
    const parsed = parseScorecard('Hole,Par,Black,Blue\n1,4,-,449');
    expect(parsed.teeSets[0]?.yardages).toEqual([null]);
    expect(parsed.teeSets[1]?.yardages).toEqual([449]);
  });

  it('strips thousands separators from a yardage', () => {
    const parsed = parseScorecard('Hole,Par,Blue\n1,4,"1,449"');
    expect(parsed.teeSets[0]?.yardages).toEqual([1449]);
  });

  it('copes with no stroke index column', () => {
    const parsed = parseScorecard('Hole,Par,Blue\n1,4,449\n2,3,180');
    expect(parsed.holes.every((hole) => hole.strokeIndex === null)).toBe(true);
    expect(parsed.problems).toEqual([]);
  });

  it('says what is missing rather than guessing', () => {
    const parsed = parseScorecard('Something,Else\n1,2');
    expect(parsed.problems[0]).toMatch(/needs a Hole column and a Par column/);
    expect(parsed.holes).toEqual([]);
  });

  it('turns a card into a course the API accepts', () => {
    const course = scorecardToCourse('Heathland', parseScorecard(CARD)) as {
      course: { name: string; totalHoles: number };
      teeSets: { name: string; parTotal: number; yardageTotal: number }[];
    };
    expect(course.course).toMatchObject({ name: 'Heathland', totalHoles: 4 });
    expect(course.teeSets).toHaveLength(3);
    expect(course.teeSets[0]).toMatchObject({ name: 'Blue', parTotal: 16, yardageTotal: 1548 });
  });
});
