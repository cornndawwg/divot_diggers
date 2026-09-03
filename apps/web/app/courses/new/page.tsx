'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiUrl } from '../../../lib/auth-client';

/**
 * The parking-lot screen: add a playable course in under a minute.
 *
 * Par is the only thing asked for, because par is the only thing scoring needs. Stroke
 * index and yardage can be filled in later, or never. Every par starts at 4 so a typical
 * nine needs only a handful of taps — tapping a hole cycles 3 -> 4 -> 5 -> 6 -> 3.
 */
const CYCLE = [3, 4, 5, 6] as const;

export default function NewCoursePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [holeCount, setHoleCount] = useState<9 | 18>(9);
  const [pars, setPars] = useState<number[]>(() => Array.from({ length: 18 }, () => 4));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => pars.slice(0, holeCount), [pars, holeCount]);
  const total = visible.reduce((sum, par) => sum + par, 0);
  const out = visible.slice(0, 9).reduce((sum, par) => sum + par, 0);
  const back = visible.slice(9).reduce((sum, par) => sum + par, 0);

  function cycle(index: number) {
    setPars((current) => {
      const next = [...current];
      const position = CYCLE.indexOf((next[index] ?? 4) as (typeof CYCLE)[number]);
      next[index] = CYCLE[(position + 1) % CYCLE.length] ?? 4;
      return next;
    });
  }

  async function save() {
    setError('');
    if (name.trim() === '') {
      setError('Give the course a name.');
      return;
    }
    setBusy(true);
    const response = await fetch(`${apiUrl}/api/courses`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        course: { name: name.trim(), totalHoles: holeCount, source: 'manual' },
        teeSets: [
          {
            name: 'Default',
            holes: visible.map((par, index) => ({ holeNumber: index + 1, par })),
          },
        ],
      }),
    });
    setBusy(false);

    if (response.status === 409) {
      setError('Create your group first, from your account page.');
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Could not save the course.');
      return;
    }
    router.push('/courses');
  }

  return (
    <>
      <h1>Add a course</h1>
      <p className="sub">Pars only. Everything else can wait.</p>

      <div className="card">
        {error !== '' && <p className="error">{error}</p>}

        <div className="field">
          <label htmlFor="name">Course name</label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Caledonia"
            autoComplete="off"
          />
        </div>

        <div className="seg">
          {([9, 18] as const).map((count) => (
            <button
              key={count}
              type="button"
              aria-pressed={holeCount === count}
              onClick={() => setHoleCount(count)}
            >
              {count} holes
            </button>
          ))}
        </div>

        <div className="holes">
          {visible.map((par, index) => (
            <div className="hole" key={index}>
              <span className="n">{index + 1}</span>
              <button
                type="button"
                onClick={() => cycle(index)}
                aria-label={`Hole ${index + 1}, par ${par}. Tap to change.`}
              >
                {par}
              </button>
            </div>
          ))}
        </div>

        <p className="totals">
          {holeCount === 18 ? (
            <>
              <span>
                Out <b>{out}</b>
              </span>
              <span>
                In <b>{back}</b>
              </span>
            </>
          ) : (
            <span />
          )}
          <span>
            Par <b>{total}</b>
          </span>
        </p>

        <button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : `Save ${holeCount}-hole course`}
        </button>
        <p className="note">
          Need stroke indexes, yardages or several tee sets?{' '}
          <Link href="/courses/new/card">Type in the whole scorecard</Link>.
        </p>
      </div>
    </>
  );
}
