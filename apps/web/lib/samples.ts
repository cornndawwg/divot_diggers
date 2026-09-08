/**
 * Sample rows for every import, so the shape is never a guess.
 *
 * Shown in the console and offered as a download. Deliberately mixed: a golfer with a target
 * and no handicap, one with a handicap and no target, one with neither contact detail, so the
 * blanks read as allowed rather than as mistakes.
 */
export const SAMPLE_ROSTER_CSV = `Name,Email,Phone,Handicap,PTP
Kenny Adkins,kenny@example.com,555-0142,,14
Lee Butler,lee@example.com,555-0199,20.0,
Shay Shamburger,,,38.0,
Mike Sinkule,mike@example.com,,6.4,
Jack Denton,,555-0177,,32`;

export const SAMPLE_SCORECARD_CSV = `Hole,Par,SI,Blue,White,Green,Red
1,4,3,449,414,374,362
2,4,11,349,323,292,228
3,3,7,211,195,187,130
4,4,13,386,338,315,285
5,5,5,539,509,435,425
6,4,9,463,392,379,246
7,5,15,477,459,429,295
8,3,17,143,136,130,90
9,4,1,442,418,370,340
10,4,4,439,415,397,326
11,4,8,410,391,368,319
12,3,18,161,145,133,105
13,5,12,544,521,512,472
14,4,14,387,365,337,272
15,4,16,346,334,315,270
16,4,2,459,428,391,308
17,3,10,217,185,175,120
18,4,6,431,387,364,311`;

/** Hand the browser a file without a server round trip. */
export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
