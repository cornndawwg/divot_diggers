'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface RoundRef {
  id: string;
  key: string;
  name: string;
  holesInPlay: number | null;
}

interface StandingRow {
  personId: string;
  displayName: string;
  startingPtp: number;
  position: number | null;
  tied: boolean;
  disqualified: boolean;
  disqualifiedBecause: string | null;
  finalStanding: number;
  carryoverRaw: number;
  carryoverRounded: number;
  rounds: {
    target: number;
    pointsPulled: number | null;
    roundDelta: number | null;
    runningTotal: number;
    didNotPlay: boolean;
  }[];
}

/** Round a fractional target for display only. The stored value keeps full precision. */
function show(value: number, places = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(places);
}

function signed(value: number): string {
  return value > 0 ? `+${show(value)}` : show(value);
}

export default function StandingsPage() {
  const [events, setEvents] = useState<{ id: string; name: string; year: number }[]>([]);
  const [eventId, setEventId] = useState('');
  const [label, setLabel] = useState('PTP');
  const [rounds, setRounds] = useState<RoundRef[]>([]);
  const [table, setTable] = useState<StandingRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'none'>('loading');

  // Entering a round as totals.
  const [entering, setEntering] = useState<RoundRef | null>(null);
  const [totals, setTotals] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id?: string) => {
    const eventsResponse = await fetch(`${apiUrl}/api/events`, { credentials: 'include' });
    if (eventsResponse.status === 401) {
      setState('signed-out');
      return;
    }
    const loaded = ((await eventsResponse.json()) as {
      events: { id: string; name: string; year: number }[];
    }).events;
    setEvents(loaded);
    if (loaded.length === 0) {
      setState('none');
      return;
    }
    const active = id ?? loaded[0]?.id ?? '';
    setEventId(active);

    const response = await fetch(`${apiUrl}/api/events/${active}/standings`, {
      credentials: 'include',
    });
    if (!response.ok) {
      setRounds([]);
      setTable([]);
      setState('ready');
      return;
    }
    const body = (await response.json()) as {
      label: string;
      rounds: RoundRef[];
      standings: StandingRow[];
    };
    setLabel(body.label);
    setRounds(body.rounds);
    setTable(body.standings);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveTotals(round: RoundRef) {
    setBusy(true);
    setMessage('');
    const payload = table.map((row) => {
      const typed = (totals[row.personId] ?? '').trim();
      return typed === ''
        ? { personId: row.personId, didNotPlay: true }
        : { personId: row.personId, pointsPulled: Number(typed) };
    });
    const response = await fetch(`${apiUrl}/api/rounds/${round.id}/totals`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totals: payload }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage('Could not save those totals.');
      return;
    }
    setEntering(null);
    setTotals({});
    setMessage(`${round.name} saved. Standings updated.`);
    await load(eventId);
  }

  if (state === 'loading') return <div className="card">Loading…</div>;
  if (state === 'signed-out') {
    return (
      <>
        <h1>Signed out</h1>
        <div className="card">
          <p className="note">
            <Link href="/sign-in">Sign in</Link>
          </p>
        </div>
      </>
    );
  }
  if (state === 'none') {
    return (
      <>
        <h1>No event yet</h1>
        <div className="card">
          <p className="note">
            Set one up on the <Link href="/roster">Roster</Link> page.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Standings</h1>
      <p className="sub">
        {table.length} {table.length === 1 ? 'player' : 'players'} ·{' '}
        {rounds.length} {rounds.length === 1 ? 'round' : 'rounds'}
      </p>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="field">
          <label htmlFor="event">Event</label>
          <select
            id="event"
            value={eventId}
            onChange={(changed) => {
              setState('loading');
              void load(changed.target.value);
            }}
          >
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.name} ({event.year})
              </option>
            ))}
          </select>
        </div>
        {message !== '' && <p className="ok">{message}</p>}
      </div>

      {rounds.length === 0 ? (
        <div className="card">
          <p className="hint">
            This event has no rounds yet. Start one from <Link href="/courses">Courses</Link>.
          </p>
        </div>
      ) : entering !== null ? (
        <div className="card">
          <h2 className="section">{entering.name} — points pulled</h2>
          <p className="hint">
            One total per player. Leave a box empty for anyone who did not play that round.
          </p>
          <ul className="list">
            {table.map((row) => (
              <li key={row.personId}>
                <span>{row.displayName}</span>
                <input
                  className="tiny"
                  inputMode="numeric"
                  value={totals[row.personId] ?? ''}
                  aria-label={`Points for ${row.displayName}`}
                  onChange={(event) =>
                    setTotals((current) => ({ ...current, [row.personId]: event.target.value }))
                  }
                  style={{ maxWidth: '5rem', flex: '0 0 auto' }}
                />
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button type="button" onClick={() => void saveTotals(entering)} disabled={busy}>
              {busy ? 'Saving…' : 'Save totals'}
            </button>
            <button type="button" className="danger" onClick={() => setEntering(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="scorecard">
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Player</th>
                  <th>{label}</th>
                  {rounds.map((round) => (
                    <th key={round.id}>{round.name}</th>
                  ))}
                  <th>Total</th>
                  <th>Next {label}</th>
                </tr>
              </thead>
              <tbody>
                {table.map((row) => (
                  <tr key={row.personId} style={row.disqualified ? { opacity: 0.55 } : undefined}>
                    <td className="rel">{row.position ?? '—'}</td>
                    <td>
                      {row.displayName}
                      {row.tied ? ' (tied)' : ''}
                      {row.disqualified && (
                        <>
                          <br />
                          <span className="meta">{row.disqualifiedBecause}</span>
                        </>
                      )}
                    </td>
                    <td className="rel">{show(row.startingPtp)}</td>
                    {row.rounds.map((round, index) => (
                      <td className="rel" key={index}>
                        {round.didNotPlay ? (
                          '—'
                        ) : (
                          <>
                            {round.pointsPulled}
                            <br />
                            <span className="meta">{signed(round.runningTotal)}</span>
                          </>
                        )}
                      </td>
                    ))}
                    <td className="score">{signed(row.finalStanding)}</td>
                    <td className="rel">{row.carryoverRounded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: '0.75rem' }}>
              The small number under each round is the running total after it. Greyed rows are
              out of the running but still shown, so you can see where they would have
              finished.
            </p>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h2 className="section">Enter a round as totals</h2>
            <p className="hint">
              For backfilling a past year, where only the points totals survive.
            </p>
            <ul className="list">
              {rounds.map((round) => (
                <li key={round.id}>
                  <span>
                    {round.name}
                    <br />
                    <span className="meta">
                      {round.holesInPlay === null ? 'hole count unknown' : `${round.holesInPlay} holes`}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEntering(round);
                      setTotals({});
                    }}
                  >
                    Enter totals
                  </button>
                </li>
              ))}
            </ul>
            <p className="note">
              <Link href="/roster">Roster</Link>
              {' · '}
              <Link href="/courses">Courses</Link>
              {' · '}
              <Link href="/rulesets">Rules</Link>
            </p>
          </div>
        </>
      )}
    </>
  );
}
