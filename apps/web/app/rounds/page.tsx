'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface Hole {
  holeNumber: number;
  par: number;
  yardage: number | null;
  strokeIndex: number | null;
}

interface Resolved {
  holes: Hole[];
  holeCount: number;
  parTotal: number;
  outPar: number | null;
  inPar: number | null;
  yardageTotal: number | null;
}

interface Round {
  id: string;
  name: string;
  status: string;
  course: string | null;
  teeSet: string | null;
  holeSelection: { mode: string };
  resolved: Resolved | null;
}

const SELECTION_LABEL: Record<string, string> = {
  all: 'All holes',
  front9: 'Front nine',
  back9: 'Back nine',
  nine: 'Named nine',
  custom: 'Custom',
};

export default function RoundsPage() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');

  const load = useCallback(async () => {
    const events = await fetch(`${apiUrl}/api/events`, { credentials: 'include' });
    if (events.status === 401) {
      setState('signed-out');
      return;
    }
    const body = (await events.json()) as { events: { id: string }[] };

    // The rounds list comes from the event; each round is then resolved by the API so the
    // hole count and par total shown here are the round's own, not the card's.
    const ids: string[] = [];
    for (const event of body.events) {
      const detail = await fetch(`${apiUrl}/api/events/${event.id}/rounds`, {
        credentials: 'include',
      });
      if (detail.ok) {
        const rows = (await detail.json()) as { rounds: { id: string }[] };
        ids.push(...rows.rounds.map((round) => round.id));
      }
    }

    const loaded = await Promise.all(
      ids.map(async (id) => {
        const response = await fetch(`${apiUrl}/api/rounds/${id}`, { credentials: 'include' });
        return response.ok ? ((await response.json()) as Round) : null;
      }),
    );
    setRounds(loaded.filter((round): round is Round => round !== null));
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <>
      <h1>Rounds</h1>
      <p className="sub">{rounds.length === 0 ? 'None yet.' : `${rounds.length} scheduled.`}</p>

      <div className="card">
        {rounds.length === 0 ? (
          <p className="note">
            Start one from <Link href="/courses">Courses</Link>.
          </p>
        ) : (
          <ul className="list">
            {rounds.map((round) => (
              <li key={round.id}>
                <span>
                  {round.name}
                  <br />
                  <span className="meta">
                    {round.course ?? 'No course'}
                    {round.teeSet !== null ? ` · ${round.teeSet}` : ''} ·{' '}
                    {SELECTION_LABEL[round.holeSelection.mode] ?? round.holeSelection.mode}
                  </span>
                </span>
                <span style={{ textAlign: 'right', flex: '0 0 auto' }}>
                  {round.resolved === null ? (
                    <span className="meta">no holes yet</span>
                  ) : (
                    <>
                      <b>
                        {round.resolved.holeCount} holes
                      </b>
                      <br />
                      <span className="meta">
                        par {round.resolved.parTotal}
                        {round.resolved.outPar !== null && round.resolved.inPar !== null
                          ? ` (${round.resolved.outPar}/${round.resolved.inPar})`
                          : ''}
                      </span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="note">
          <Link href="/courses">Courses</Link>
          {' · '}
          <Link href="/dashboard">Account</Link>
        </p>
      </div>
    </>
  );
}
