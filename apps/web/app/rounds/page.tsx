'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';
import { useCurrentEvent } from '../../lib/current-event';

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
  isPractice: boolean;
  feedsNothing: boolean;
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
  const { eventId, event } = useCurrentEvent();

  const load = useCallback(async () => {
    if (eventId === '') {
      setRounds([]);
      setState('ready');
      return;
    }

    // One event's rounds. This used to merge every event's together, which is why a round
    // looked as though it belonged to nothing in particular.
    const detail = await fetch(`${apiUrl}/api/events/${eventId}/rounds`, {
      credentials: 'include',
    });
    if (detail.status === 401) {
      setState('signed-out');
      return;
    }
    const ids: string[] = [];
    if (detail.ok) {
      const rows = (await detail.json()) as { rounds: { id: string }[] };
      ids.push(...rows.rounds.map((round) => round.id));
    }

    const loaded = await Promise.all(
      ids.map(async (id) => {
        const response = await fetch(`${apiUrl}/api/rounds/${id}`, { credentials: 'include' });
        return response.ok ? ((await response.json()) as Round) : null;
      }),
    );
    setRounds(loaded.filter((round): round is Round => round !== null));
    setState('ready');
  }, [eventId]);

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
      <p className="hint">
        {event === null ? 'No event selected.' : `The rounds of ${event.name}.`}
      </p>
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
                  {round.isPractice && (
                    <span className="meta"> · practice, does not count</span>
                  )}
                  <br />
                  <span className="meta">
                    {round.course ?? 'No course'}
                    {round.teeSet !== null ? ` · ${round.teeSet}` : ''} ·{' '}
                    {SELECTION_LABEL[round.holeSelection.mode] ?? round.holeSelection.mode}
                  </span>
                  {/*
                    * A round feeding nothing and not marked practice is misconfigured, which
                    * has happened before and scored nobody without saying so.
                    */}
                  {round.feedsNothing && (
                    <>
                      <br />
                      <span className="check fail">
                        This round feeds no competition, so nothing it scores will count. If
                        that is deliberate, schedule it as a practice round.
                      </span>
                    </>
                  )}
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
