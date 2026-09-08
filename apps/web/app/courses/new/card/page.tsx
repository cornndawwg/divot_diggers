'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { courseDocumentSchema, validateCourseDocument } from '@ddga/types';
import { apiUrl } from '../../../../lib/auth-client';
import { parseScorecard } from '../../../../lib/csv';
import { SAMPLE_SCORECARD_CSV, downloadCsv } from '../../../../lib/samples';

/**
 * The whole scorecard, typed in.
 *
 * Par and stroke index are entered once and applied to every tee set, because that is how a
 * card reads — Caledonia's four tee sets share their pars. Yardage is per tee set, since that
 * is the thing that actually differs. The ten checks from the spec run as you type, so a
 * mistyped par shows up here rather than on the 4th tee.
 */

interface TeeSetDraft {
  name: string;
  gender: 'mens' | 'womens' | 'unisex';
  courseRating: string;
  slopeRating: string;
  yardages: string[];
}

function emptyTeeSet(name: string, holes: number): TeeSetDraft {
  return {
    name,
    gender: 'mens',
    courseRating: '',
    slopeRating: '',
    yardages: Array.from({ length: holes }, () => ''),
  };
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function FullCardPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [holeCount, setHoleCount] = useState<9 | 18>(18);
  const [pars, setPars] = useState<string[]>(() => Array.from({ length: 18 }, () => '4'));
  const [indexes, setIndexes] = useState<string[]>(() => Array.from({ length: 18 }, () => ''));
  const [teeSets, setTeeSets] = useState<TeeSetDraft[]>(() => [emptyTeeSet('Championship', 18)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [csv, setCsv] = useState('');
  const [csvNote, setCsvNote] = useState('');

  const holes = useMemo(
    () => Array.from({ length: holeCount }, (_, index) => index + 1),
    [holeCount],
  );

  /** The document that would be saved, built from what has been typed so far. */
  const document = useMemo(() => {
    return {
      course: {
        name: name.trim() === '' ? 'Untitled course' : name.trim(),
        totalHoles: holeCount,
        source: 'manual',
      },
      teeSets: teeSets.map((teeSet) => {
        const teeHoles = holes.map((hole, index) => {
          const par = numberOrNull(pars[index] ?? '');
          const strokeIndex = numberOrNull(indexes[index] ?? '');
          const yardage = numberOrNull(teeSet.yardages[index] ?? '');
          return {
            holeNumber: hole,
            par: par ?? 4,
            ...(strokeIndex === null ? {} : { strokeIndex }),
            ...(yardage === null ? {} : { yardage }),
          };
        });
        const yardageTotal = teeHoles.reduce(
          (sum, hole) => sum + ((hole as { yardage?: number }).yardage ?? 0),
          0,
        );
        return {
          name: teeSet.name.trim() === '' ? 'Tees' : teeSet.name.trim(),
          gender: teeSet.gender,
          ...(numberOrNull(teeSet.courseRating) === null
            ? {}
            : { courseRating: numberOrNull(teeSet.courseRating) }),
          ...(numberOrNull(teeSet.slopeRating) === null
            ? {}
            : { slopeRating: numberOrNull(teeSet.slopeRating) }),
          parTotal: teeHoles.reduce((sum, hole) => sum + hole.par, 0),
          ...(yardageTotal > 0 ? { yardageTotal } : {}),
          holes: teeHoles,
        };
      }),
    };
  }, [name, holeCount, pars, indexes, teeSets, holes]);

  /** The same ten checks the import pipeline runs, live. */
  const checks = useMemo(() => {
    const parsed = courseDocumentSchema.safeParse(document);
    if (!parsed.success) {
      return {
        valid: false,
        failures: parsed.error.issues.slice(0, 4).map((issue) => issue.message),
        warnings: [] as string[],
        passed: 0,
      };
    }
    const result = validateCourseDocument(parsed.data);
    return {
      valid: result.valid,
      failures: result.errors.map((entry) =>
        entry.teeSet === null ? entry.detail ?? entry.label : `${entry.teeSet}: ${entry.detail ?? entry.label}`,
      ),
      warnings: result.warnings.map((entry) => entry.detail ?? entry.label),
      passed: result.checks.filter((entry) => entry.status === 'pass').length,
    };
  }, [document]);

  const parTotal = holes.reduce((sum, _hole, index) => sum + (numberOrNull(pars[index] ?? '') ?? 0), 0);
  const outPar = holes.slice(0, 9).reduce((sum, _h, i) => sum + (numberOrNull(pars[i] ?? '') ?? 0), 0);
  const inPar = parTotal - outPar;

  function setHoles(count: 9 | 18) {
    setHoleCount(count);
    setTeeSets((current) =>
      current.map((teeSet) => ({
        ...teeSet,
        yardages: Array.from({ length: count }, (_, index) => teeSet.yardages[index] ?? ''),
      })),
    );
  }

  function editTeeSet(position: number, patch: Partial<TeeSetDraft>) {
    setTeeSets((current) =>
      current.map((teeSet, index) => (index === position ? { ...teeSet, ...patch } : teeSet)),
    );
  }

  function editYardage(position: number, holeIndex: number, value: string) {
    setTeeSets((current) =>
      current.map((teeSet, index) => {
        if (index !== position) return teeSet;
        const yardages = [...teeSet.yardages];
        yardages[holeIndex] = value;
        return { ...teeSet, yardages };
      }),
    );
  }

  async function save() {
    setError('');
    if (name.trim() === '') {
      setError('Give the course a name.');
      return;
    }
    if (!checks.valid) {
      setError('The card does not add up yet. See below.');
      return;
    }
    setBusy(true);
    const response = await fetch(`${apiUrl}/api/courses`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(document),
    });
    setBusy(false);
    if (response.status === 409) {
      setError('Create your group first, on the Account page.');
      return;
    }
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(body.error ?? 'Could not save the course.');
      return;
    }
    router.push('/courses');
  }

  /**
   * Read a printed card in one paste.
   *
   * Any column that is not hole, par or stroke index is taken as a tee set named by its
   * heading, which is how Blue/White/Green/Red end up as tee names with nothing configured.
   */
  function readCsv(text: string) {
    const parsed = parseScorecard(text);
    if (parsed.holes.length === 0) {
      setCsvNote(parsed.problems.join(' ') || 'Nothing readable in that.');
      return;
    }
    setHoleCount(parsed.holes.length > 9 ? 18 : 9);
    setPars(parsed.holes.map((hole) => String(hole.par)));
    setIndexes(parsed.holes.map((hole) => (hole.strokeIndex === null ? '' : String(hole.strokeIndex))));
    const usable = parsed.teeSets.filter((tee) => tee.yardages.some((value) => value !== null));
    if (usable.length > 0) {
      setTeeSets(
        usable.map((tee) => ({
          name: tee.name,
          gender: 'mens' as const,
          courseRating: '',
          slopeRating: '',
          yardages: tee.yardages.map((value) => (value === null ? '' : String(value))),
        })),
      );
    }
    setCsvNote(
      `Read ${parsed.holes.length} holes and ${usable.length} tee ${usable.length === 1 ? 'set' : 'sets'}. ` +
        'Check it below, add ratings and slopes if you want them, then save.' +
        (parsed.problems.length > 0 ? ` ${parsed.problems.join(' ')}` : ''),
    );
  }

  return (
    <>
      <h1>Type in a scorecard</h1>
      <p className="sub">
        Par, stroke index and yardage, tee set by tee set. Only par is required.
      </p>

      <div className="card">
        {error !== '' && <p className="error">{error}</p>}

        <div className="field">
          <label htmlFor="name">Course name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Caledonia Golf &amp; Fish Club" />
        </div>

        <div className="seg">
          {([9, 18] as const).map((count) => (
            <button key={count} type="button" aria-pressed={holeCount === count} onClick={() => setHoles(count)}>
              {count} holes
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">Or paste the card</h2>
        <p className="hint" style={{ marginBottom: '0.6rem' }}>
          A row per hole, with Hole and Par columns and one column per tee. OUT, IN and TOTAL
          rows are ignored. Everything lands in the table below for checking before it saves.
        </p>
        <p className="note" style={{ margin: '0 0 0.7rem' }}>
          <button
            type="button"
            className="link-button"
            onClick={() => downloadCsv('scorecard-template.csv', SAMPLE_SCORECARD_CSV)}
          >
            Download a sample
          </button>
          {' · '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setCsv(SAMPLE_SCORECARD_CSV);
              readCsv(SAMPLE_SCORECARD_CSV);
            }}
          >
            Try it with the sample
          </button>
        </p>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          aria-label="Choose a scorecard CSV"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            const text = await file.text();
            setCsv(text);
            readCsv(text);
          }}
          style={{ marginBottom: '0.6rem' }}
        />
        <textarea
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          rows={4}
          aria-label="Paste a scorecard"
          placeholder={'Hole,Par,SI,Blue,White\n1,4,3,449,414'}
        />
        <button type="button" onClick={() => readCsv(csv)} disabled={csv.trim() === ''} style={{ marginTop: '0.5rem' }}>
          Read this card
        </button>
        {csvNote !== '' && <p className="ok" style={{ marginTop: '0.7rem' }}>{csvNote}</p>}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">Tee sets</h2>
        {teeSets.map((teeSet, position) => (
          <div key={position} className="row" style={{ marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <input
              value={teeSet.name}
              onChange={(e) => editTeeSet(position, { name: e.target.value })}
              placeholder="Tee name"
              aria-label={`Tee set ${position + 1} name`}
            />
            <input
              value={teeSet.courseRating}
              onChange={(e) => editTeeSet(position, { courseRating: e.target.value })}
              placeholder="Rating"
              inputMode="decimal"
              aria-label={`${teeSet.name} course rating`}
              style={{ maxWidth: '6rem' }}
            />
            <input
              value={teeSet.slopeRating}
              onChange={(e) => editTeeSet(position, { slopeRating: e.target.value })}
              placeholder="Slope"
              inputMode="numeric"
              aria-label={`${teeSet.name} slope rating`}
              style={{ maxWidth: '6rem' }}
            />
            {teeSets.length > 1 && (
              <button
                type="button"
                className="danger"
                onClick={() => setTeeSets((current) => current.filter((_, index) => index !== position))}
                aria-label={`Remove ${teeSet.name}`}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="link-button"
          onClick={() => setTeeSets((current) => [...current, emptyTeeSet(`Tees ${current.length + 1}`, holeCount)])}
        >
          + another tee set
        </button>
        <p className="hint">
          Rating and slope are only needed for net scoring. Leave them blank otherwise.
        </p>
      </div>

      <div className="card" style={{ marginTop: '1rem', overflowX: 'auto' }}>
        <h2 className="section">The card</h2>
        <table className="scorecard">
          <thead>
            <tr>
              <th>Hole</th>
              <th>Par</th>
              <th>SI</th>
              {teeSets.map((teeSet, index) => (
                <th key={index}>{teeSet.name || 'Tees'}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {holes.map((hole, index) => (
              <tr key={hole}>
                <td className="rel">{hole}</td>
                <td>
                  <input
                    className="tiny"
                    value={pars[index] ?? ''}
                    inputMode="numeric"
                    aria-label={`Par for hole ${hole}`}
                    onChange={(e) =>
                      setPars((current) => {
                        const next = [...current];
                        next[index] = e.target.value;
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    className="tiny"
                    value={indexes[index] ?? ''}
                    inputMode="numeric"
                    aria-label={`Stroke index for hole ${hole}`}
                    onChange={(e) =>
                      setIndexes((current) => {
                        const next = [...current];
                        next[index] = e.target.value;
                        return next;
                      })
                    }
                  />
                </td>
                {teeSets.map((teeSet, position) => (
                  <td key={position}>
                    <input
                      className="tiny wide"
                      value={teeSet.yardages[index] ?? ''}
                      inputMode="numeric"
                      aria-label={`${teeSet.name} yardage for hole ${hole}`}
                      onChange={(e) => editYardage(position, index, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="rel">Total</td>
              <td className="score">{parTotal}</td>
              <td />
              {teeSets.map((teeSet, index) => (
                <td className="score" key={index}>
                  {teeSet.yardages
                    .slice(0, holeCount)
                    .reduce((sum, value) => sum + (numberOrNull(value) ?? 0), 0) || ''}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
        {holeCount === 18 && (
          <p className="totals">
            <span>
              Out <b>{outPar}</b>
            </span>
            <span>
              In <b>{inPar}</b>
            </span>
            <span>
              Par <b>{parTotal}</b>
            </span>
          </p>
        )}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">Checks</h2>
        {checks.failures.length === 0 && checks.warnings.length === 0 ? (
          <p className="ok">{checks.passed} checks pass. Nothing to fix.</p>
        ) : (
          <>
            {checks.failures.map((message, index) => (
              <p className="check fail" key={`f${index}`}>
                {message}
              </p>
            ))}
            {checks.warnings.map((message, index) => (
              <p className="check" key={`w${index}`} style={{ color: '#8a6d00' }}>
                {message}
              </p>
            ))}
          </>
        )}
        <button type="button" onClick={() => void save()} disabled={busy} style={{ marginTop: '0.75rem' }}>
          {busy ? 'Saving…' : 'Save course'}
        </button>
        <p className="note">
          <Link href="/courses/new">Just the pars instead</Link>
          {' · '}
          <Link href="/courses">Courses</Link>
        </p>
      </div>
    </>
  );
}
