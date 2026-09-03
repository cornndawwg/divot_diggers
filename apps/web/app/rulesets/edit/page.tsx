'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeParseRuleset, type Ruleset } from '@ddga/types';
import { applyRound, holePoints, initialTargetState, pickupCapRelativeToPar } from '@ddga/scoring-engine';
import { apiUrl } from '../../../lib/auth-client';
import {
  blankDraft,
  describeRelativeToPar,
  profileOf,
  setPath,
  sortedTable,
  suggestedLabel,
  tableOf,
  targetCompetitionOf,
  type Draft,
  type TableRow,
} from '../../../lib/ruleset-draft';

/** A hypothetical nine, so the preview has something to score. */
const PREVIEW_PARS = [4, 3, 5, 4, 4, 3, 4, 5, 4];

function RulesetEditor() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get('from');

  const [draft, setDraft] = useState<Draft>(() => blankDraft());
  const [loading, setLoading] = useState(from !== null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // The hypothetical scorecard the planner plays with.
  const [strokes, setStrokes] = useState<number[]>([4, 4, 5, 5, 4, 3, 6, 5, 4]);
  const [startingTarget, setStartingTarget] = useState(36);

  useEffect(() => {
    if (from === null) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${apiUrl}/api/rulesets/${from}`, { credentials: 'include' });
      if (cancelled) return;
      if (response.ok) {
        const body = (await response.json()) as { document: Draft };
        setDraft(body.document);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [from]);

  const update = useCallback((path: string, value: unknown) => {
    setDraft((current) => setPath(current, path, value));
  }, []);

  const profile = profileOf(draft);
  const table = sortedTable(tableOf(draft));
  const competition = targetCompetitionOf(draft);

  /**
   * Validate with the very schema the server uses. The planner sees the same objection they
   * would get on save, while they are still typing, in words rather than as an error code.
   */
  const validation = useMemo(() => safeParseRuleset(draft), [draft]);
  const parsed: Ruleset | null = validation.success ? validation.data : null;

  /** The preview, computed by the real engine — not a re-implementation of it. */
  const preview = useMemo(() => {
    if (parsed === null) return null;
    const scoringProfile = parsed.scoringProfiles[0];
    if (scoringProfile === undefined) return null;

    const holes = PREVIEW_PARS.map((par, index) => {
      const taken = strokes[index] ?? par;
      return {
        hole: index + 1,
        par,
        strokes: taken,
        points: holePoints(taken, par, scoringProfile),
        relativeToPar: taken - par,
      };
    });
    const total = holes.reduce((sum, hole) => sum + hole.points, 0);

    const targetCompetition = parsed.competitions.find(
      (entry) => entry.type === 'individual_target',
    );
    const outcome =
      targetCompetition?.type === 'individual_target'
        ? applyRound(initialTargetState(startingTarget), total, targetCompetition.target, {
            holesInPlay: PREVIEW_PARS.length,
          })
        : null;

    return {
      holes,
      total,
      cap: pickupCapRelativeToPar(scoringProfile),
      outcome,
      targetLabel:
        targetCompetition?.type === 'individual_target'
          ? targetCompetition.target.label
          : 'Target',
    };
  }, [parsed, strokes, startingTarget]);

  function editRow(index: number, patch: Partial<TableRow>) {
    const rows = tableOf(draft);
    const next = rows.map((row, position) => (position === index ? { ...row, ...patch } : row));
    update('scoringProfiles.0.table', next);
  }

  /**
   * Rows extend in both directions. Adding only at the worse end left no way to score an
   * albatross, which is exactly the kind of thing a group's table has to be able to hold.
   * The schema requires the rows to run consecutively, so each button steps one from an end.
   */
  function addWorseRow() {
    const rows = sortedTable(tableOf(draft));
    const worst = rows[rows.length - 1];
    const relativeToPar = (worst?.relativeToPar ?? -1) + 1;
    update('scoringProfiles.0.table', [
      ...rows,
      { relativeToPar, label: suggestedLabel(relativeToPar), points: 0 },
    ]);
  }

  function addBetterRow() {
    const rows = sortedTable(tableOf(draft));
    const best = rows[0];
    const relativeToPar = (best?.relativeToPar ?? 1) - 1;
    update('scoringProfiles.0.table', [
      { relativeToPar, label: suggestedLabel(relativeToPar), points: (best?.points ?? 0) + 1 },
      ...rows,
    ]);
  }

  function removeRow(relativeToPar: number) {
    update(
      'scoringProfiles.0.table',
      tableOf(draft).filter((row) => row.relativeToPar !== relativeToPar),
    );
  }

  async function save() {
    setSaveError('');
    if (!validation.success) {
      setSaveError('Fix the points above before saving.');
      return;
    }
    setSaving(true);
    const response = await fetch(`${apiUrl}/api/rulesets`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setSaving(false);
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setSaveError(body.error ?? 'Could not save these rules.');
      return;
    }
    router.push('/rulesets');
  }

  if (loading) return <div className="card">Loading…</div>;

  const issues = validation.success ? [] : validation.error.issues;

  return (
    <>
      <h1>{String(draft['name'] ?? 'Rules')}</h1>
      <p className="sub">Change anything. The preview on the right follows along.</p>

      <div className="split">
        <div>
          <div className="card">
            <div className="field">
              <label htmlFor="name">What these rules are called</label>
              <input
                id="name"
                value={String(draft['name'] ?? '')}
                onChange={(event) => update('name', event.target.value)}
              />
            </div>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h2 className="section">Points per hole</h2>
            <p className="hint">
              What a score is worth, relative to par. Add or remove rows to suit your group.
            </p>

            <table className="points">
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Called</th>
                  <th>Points</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {table.map((row) => {
                  const index = tableOf(draft).findIndex(
                    (entry) => entry.relativeToPar === row.relativeToPar,
                  );
                  return (
                    <tr key={row.relativeToPar}>
                      <td className="rel">{describeRelativeToPar(row.relativeToPar)}</td>
                      <td>
                        <input
                          value={row.label}
                          aria-label={`Name for ${describeRelativeToPar(row.relativeToPar)}`}
                          onChange={(event) => editRow(index, { label: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="points-input"
                          type="number"
                          value={row.points}
                          aria-label={`Points for ${row.label}`}
                          onChange={(event) =>
                            editRow(index, { points: Number(event.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Remove ${row.label}`}
                          onClick={() => removeRow(row.relativeToPar)}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button type="button" className="link-button" onClick={addBetterRow}>
                + better score
              </button>
              <button type="button" className="link-button" onClick={addWorseRow}>
                + worse score
              </button>
            </div>
            <p className="hint">
              Rows have to run consecutively, so each button adds one step beyond an end.
              Removing a row from the middle would leave a score with no value.
            </p>

            <div className="field" style={{ marginTop: '1rem' }}>
              <label htmlFor="better">Anything better than the table</label>
              <select
                id="better"
                value={
                  (profile?.['betterThanTable'] as { mode?: string } | undefined)?.mode ?? 'clamp'
                }
                onChange={(event) =>
                  update(
                    'scoringProfiles.0.betterThanTable',
                    event.target.value === 'clamp'
                      ? { mode: 'clamp' }
                      : { mode: 'value', points: 0 },
                  )
                }
              >
                <option value="clamp">Scores the same as the best row</option>
                <option value="value">Scores nothing</option>
              </select>
              <p className="hint">
                A hole-in-one on a par 5 is four under. If your table stops at three under,
                this decides what it is worth.
              </p>
            </div>

            <div className="field">
              <label htmlFor="worse">Anything worse than the table</label>
              <select
                id="worse"
                value={
                  (profile?.['worseThanTable'] as { mode?: string } | undefined)?.mode ?? 'value'
                }
                onChange={(event) =>
                  update(
                    'scoringProfiles.0.worseThanTable',
                    event.target.value === 'clamp'
                      ? { mode: 'clamp' }
                      : { mode: 'value', points: 0 },
                  )
                }
              >
                <option value="value">Scores nothing</option>
                <option value="clamp">Scores the same as the worst row</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="pickup">When a player picks up</label>
              <select
                id="pickup"
                value={(profile?.['pickup'] as { policy?: string } | undefined)?.policy ?? 'cap_at_first_zero'}
                onChange={(event) =>
                  update('scoringProfiles.0.pickup', {
                    policy: event.target.value,
                    fixedRelativeToPar: null,
                    recordCappedStrokes: true,
                  })
                }
              >
                <option value="cap_at_first_zero">
                  Stop at the first score worth nothing
                </option>
                <option value="play_out">Play every hole out</option>
              </select>
            </div>
          </div>

          {competition !== undefined && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h2 className="section">The target</h2>
              <p className="hint">
                Each player plays against a number. This is how that number behaves.
              </p>

              <div className="field">
                <label htmlFor="target-label">What you call it</label>
                <input
                  id="target-label"
                  value={String(
                    (competition['target'] as Record<string, unknown>)['label'] ?? '',
                  )}
                  onChange={(event) => {
                    const index = (draft['competitions'] as unknown[]).indexOf(competition);
                    update(`competitions.${index}.target.label`, event.target.value);
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="factor">
                  How much of a round&apos;s result folds back into the target
                </label>
                <select
                  id="factor"
                  value={String(
                    (competition['target'] as Record<string, unknown>)['adjustmentFactor'] ?? 0,
                  )}
                  onChange={(event) => {
                    const index = (draft['competitions'] as unknown[]).indexOf(competition);
                    update(
                      `competitions.${index}.target.adjustmentFactor`,
                      Number(event.target.value),
                    );
                  }}
                >
                  <option value="0">None — the target never moves</option>
                  <option value="0.25">A quarter</option>
                  <option value="0.5">Half</option>
                  <option value="1">All of it</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="carry">Between one year and the next</label>
                <select
                  id="carry"
                  value={String(
                    (competition['target'] as Record<string, unknown>)['carryover'] ?? 'none',
                  )}
                  onChange={(event) => {
                    const index = (draft['competitions'] as unknown[]).indexOf(competition);
                    update(`competitions.${index}.target.carryover`, event.target.value);
                  }}
                >
                  <option value="across_events">The target carries forward</option>
                  <option value="none">Everyone starts fresh</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="holes">A full round is</label>
                <input
                  id="holes"
                  type="number"
                  min={1}
                  max={36}
                  value={Number(
                    (competition['target'] as Record<string, unknown>)['holesPerFullRound'] ?? 18,
                  )}
                  onChange={(event) => {
                    const index = (draft['competitions'] as unknown[]).indexOf(competition);
                    update(
                      `competitions.${index}.target.holesPerFullRound`,
                      Number(event.target.value),
                    );
                  }}
                />
                <p className="hint">
                  Holes. Shorter rounds can be scaled against this — see the preview.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        <div>
          <div className="card preview">
            <h2 className="section">Preview</h2>
            {preview === null ? (
              <p className="hint">
                The preview appears once the points above make sense.
              </p>
            ) : (
              <>
                <p className="hint">
                  A made-up nine. Change a stroke count, or a point value on the left, and watch
                  everything below move.
                </p>

                <table className="points">
                  <thead>
                    <tr>
                      <th>Hole</th>
                      <th>Par</th>
                      <th>Strokes</th>
                      <th>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.holes.map((hole, index) => (
                      <tr key={hole.hole}>
                        <td className="rel">{hole.hole}</td>
                        <td className="rel">{hole.par}</td>
                        <td>
                          <input
                            className="points-input"
                            type="number"
                            min={1}
                            value={hole.strokes}
                            aria-label={`Strokes on hole ${hole.hole}`}
                            onChange={(event) =>
                              setStrokes((current) => {
                                const next = [...current];
                                next[index] = Number(event.target.value);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="score">{hole.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p className="totals">
                  <span>
                    Points <b>{preview.total}</b>
                  </span>
                  {preview.cap !== null && (
                    <span>
                      Pick up at <b>par +{preview.cap}</b>
                    </span>
                  )}
                </p>

                {preview.outcome !== null && (
                  <>
                    <div className="field">
                      <label htmlFor="start">
                        Playing against a {preview.targetLabel.toLowerCase()} of
                      </label>
                      <input
                        id="start"
                        type="number"
                        value={startingTarget}
                        onChange={(event) => setStartingTarget(Number(event.target.value))}
                      />
                    </div>
                    <dl className="outcome">
                      <dt>Played against</dt>
                      <dd>{preview.outcome.effectiveTarget}</dd>
                      <dt>Result this round</dt>
                      <dd>
                        {(preview.outcome.roundDelta ?? 0) > 0 ? '+' : ''}
                        {preview.outcome.roundDelta}
                      </dd>
                      <dt>Next {preview.targetLabel.toLowerCase()}</dt>
                      <dd>{preview.outcome.nextTarget}</dd>
                    </dl>
                  </>
                )}
              </>
            )}
          </div>

          {issues.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h2 className="section">Needs attention</h2>
              {issues.slice(0, 6).map((issue, index) => (
                <p className="check fail" key={index}>
                  {issue.message}
                </p>
              ))}
            </div>
          )}

          <div className="card" style={{ marginTop: '1rem' }}>
            {saveError !== '' && <p className="error">{saveError}</p>}
            <button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save as a new version'}
            </button>
            <p className="note">
              <Link href="/rulesets">Back to rules</Link>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

export default function RulesetEditPage() {
  return (
    <Suspense fallback={<div className="card">Loading…</div>}>
      <RulesetEditor />
    </Suspense>
  );
}
