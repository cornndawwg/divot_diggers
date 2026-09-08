import { describe, expect, it } from 'vitest';
import { parseDelimited, parseRoster } from '../lib/csv';

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
