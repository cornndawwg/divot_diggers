'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiUrl } from '../../../lib/auth-client';

/**
 * Setting an event up, step by step.
 *
 * An event used to appear from a corner of the roster page with a name and nothing else —
 * no dates, no sense of what happens next, and a cup page immediately complaining that two
 * players cannot contest twenty-four points. Each step here does one thing and says what it
 * affects, and the last one says plainly what is still to do.
 */
const THIS_YEAR = new Date().getUTCFullYear();

export default function NewEventPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [year, setYear] = useState(String(THIS_YEAR + 1));
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const yearNumber = Number(year);
  const yearLooksRight = Number.isInteger(yearNumber) && yearNumber > 1900 && yearNumber < 2200;
  const datesInOrder = startDate === '' || endDate === '' || endDate >= startDate;

  async function create() {
    setBusy(true);
    setError('');
    const response = await fetch(`${apiUrl}/api/events`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        year: yearNumber,
        ...(startDate === '' ? {} : { startDate }),
        ...(endDate === '' ? {} : { endDate }),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(((await response.json()) as { error?: string }).error ?? 'Could not create it.');
      return;
    }
    const created = (await response.json()) as { id: string };
    router.push(`/events/${created.id}`);
  }

  return (
    <main className="page">
      <h1>Set up an event</h1>
      <p className="hint">Step {step + 1} of 3</p>

      {step === 0 && (
        <div className="card">
          <h2 className="section">What is it called, and which year?</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            The name is what everyone sees. The year is what carries a player&rsquo;s target
            forward from the last one they played.
          </p>
          <div className="field">
            <label htmlFor="name">Event name</label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Divot Diggers ${THIS_YEAR + 1}`}
            />
          </div>
          <div className="field">
            <label htmlFor="year">Year</label>
            <input id="year" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
            {!yearLooksRight && <p className="check fail">That does not look like a year.</p>}
          </div>
          <button type="button" onClick={() => setStep(1)} disabled={name.trim() === '' || !yearLooksRight}>
            Next
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2 className="section">When is it?</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Both optional, and both changeable later. They are what the app uses to tell a
            player whether a trip is coming up or already behind them.
          </p>
          <div className="field">
            <label htmlFor="start">First day</label>
            <input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="end">Last day</label>
            <input id="end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            {!datesInOrder && <p className="check fail">It cannot end before it starts.</p>}
          </div>
          <div className="row">
            <button type="button" className="ghost" onClick={() => setStep(0)}>Back</button>
            <button type="button" onClick={() => setStep(2)} disabled={!datesInOrder}>Next</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2 className="section">Ready</h2>
          <p><b>{name.trim()}</b>, {year}</p>
          <p className="meta">
            {startDate === '' && endDate === ''
              ? 'No dates set — you can add them later.'
              : `${startDate || '?'} to ${endDate || '?'}`}
          </p>
          <p className="hint">
            It will be created as a draft using your group&rsquo;s current rules. Nothing is
            frozen until the event starts, so the rules can still change before then.
          </p>
          <p className="hint">
            After this: add the roster and set starting targets, then invite everyone, then
            schedule the rounds. The cup sorts itself out once there are enough players —
            until then it will say so, which is expected rather than a problem.
          </p>
          {error !== '' && <p className="check fail">{error}</p>}
          <div className="row">
            <button type="button" className="ghost" onClick={() => setStep(1)}>Back</button>
            <button type="button" onClick={() => void create()} disabled={busy}>
              {busy ? 'Creating…' : 'Create the event'}
            </button>
          </div>
        </div>
      )}

      <p className="hint" style={{ marginTop: '1rem' }}>
        <Link href="/events">Back to events</Link>
      </p>
    </main>
  );
}
