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
  playedOn: string | null;
  firstTee: string | null;
  lastTee: string | null;
  groups: number;
  locked: number;
  scored: number;
}

/** "Thursday 12 August", or a note that nobody has said yet. */
function describeDay(iso: string | null): string {
  if (iso === null) return 'Day not set';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
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
    let listed: Round[] = [];
    if (detail.ok) {
      listed = ((await detail.json()) as { rounds: Round[] }).rounds;
    }

    const loaded = await Promise.all(
      listed.map(async (row) => {
        const response = await fetch(`${apiUrl}/api/rounds/${row.id}`, { credentials: 'include' });
        if (!response.ok) return null;
        // The list knows when it is played and who is out when; the detail knows the holes
        // and the par. Neither knows both.
        return { ...(await response.json()), ...row } as Round;
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
            {rounds.map((round, index) => (
              <li key={round.id}>
                {/*
                  * A heading each time the day changes. The API returns them in the order
                  * the trip happens, so this needs no sorting of its own.
                  */}
                {(index === 0 || rounds[index - 1]?.playedOn !== round.playedOn) && (
                  <span
                    style={{
                      flexBasis: '100%',
                      fontWeight: 700,
                      marginTop: index === 0 ? 0 : '0.9rem',
                      marginBottom: '0.2rem',
                    }}
                  >
                    {describeDay(round.playedOn)}
                  </span>
                )}
                <span>
                  {round.name}
                  {round.isPractice && (
                    <span className="meta"> · practice, does not count</span>
                  )}
                  <br />
                  <span className="meta">
                    {round.firstTee !== null && (
                      <>
                        {round.firstTee}
                        {round.lastTee !== null && round.lastTee !== round.firstTee
                          ? `–${round.lastTee}`
                          : ''}
                        {' · '}
                      </>
                    )}
                    {round.course ?? 'No course'}
                    {round.teeSet !== null ? ` · ${round.teeSet}` : ''} ·{' '}
                    {SELECTION_LABEL[round.holeSelection.mode] ?? round.holeSelection.mode}
                  </span>
                  <br />
                  <span className="meta">
                    {round.groups === 0
                      ? 'No tee sheet yet'
                      : `${round.groups} ${round.groups === 1 ? 'group' : 'groups'}${
                          round.locked > 0 ? ', locked' : ''
                        }`}
                    {round.scored > 0
                      ? ` · ${round.scored} scored`
                      : round.isPractice
                        ? ''
                        : ' · nobody scored yet'}
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
                  <Link href={`/rounds/${round.id}`} className="meta">Edit</Link>
                  <br />
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
