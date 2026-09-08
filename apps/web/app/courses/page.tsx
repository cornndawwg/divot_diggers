'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface Course {
  id: string;
  name: string;
  totalHoles: number;
  completeness: string;
  teeSets: number;
}

interface EventSummary {
  id: string;
  name: string;
  year: number;
  rounds: number;
}

export default function CoursesPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventId, setEventId] = useState('');
  const [rosterSize, setRosterSize] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');
  const [message] = useState('');

  const load = useCallback(async () => {
    const [coursesResponse, eventsResponse] = await Promise.all([
      fetch(`${apiUrl}/api/courses`, { credentials: 'include' }),
      fetch(`${apiUrl}/api/events`, { credentials: 'include' }),
    ]);
    if (coursesResponse.status === 401) {
      setState('signed-out');
      return;
    }
    setCourses(((await coursesResponse.json()) as { courses: Course[] }).courses);
    const loaded = ((await eventsResponse.json()) as { events: EventSummary[] }).events;
    setEvents(loaded);
    const active = loaded[0]?.id ?? '';
    setEventId(active);
    if (active !== '') {
      const players = await fetch(`${apiUrl}/api/events/${active}/players`, {
        credentials: 'include',
      });
      setRosterSize(
        players.ok ? ((await players.json()) as { players: unknown[] }).players.length : null,
      );
    }
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
      <h1>Courses</h1>
      <p className="sub">
        {courses.length === 0 ? 'None yet.' : `${courses.length} available.`}
      </p>

      {events.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="field">
            <label htmlFor="event">Start rounds in</label>
            <select
              id="event"
              value={eventId}
              onChange={async (changed) => {
                setEventId(changed.target.value);
                const players = await fetch(
                  `${apiUrl}/api/events/${changed.target.value}/players`,
                  { credentials: 'include' },
                );
                setRosterSize(
                  players.ok
                    ? ((await players.json()) as { players: unknown[] }).players.length
                    : null,
                );
              }}
            >
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name} ({event.year}) — {event.rounds}{' '}
                  {event.rounds === 1 ? 'round' : 'rounds'}
                </option>
              ))}
            </select>
          </div>
          {rosterSize === 0 && (
            <p className="check fail">
              This event has nobody on its roster yet, so a round on it cannot be grouped or
              scored. Add players on the <Link href="/roster">Roster</Link> page first.
            </p>
          )}
          {rosterSize !== null && rosterSize > 0 && (
            <p className="hint">
              {rosterSize} {rosterSize === 1 ? 'player' : 'players'} on this roster.
            </p>
          )}
        </div>
      )}

      {events.length === 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <p className="check fail">
            No event yet. Create one on the <Link href="/roster">Roster</Link> page before
            starting a round.
          </p>
        </div>
      )}

      <div className="card">
        {message !== '' && <p className="ok">{message}</p>}

        {courses.length === 0 ? (
          <p className="note">Add one and you can start a round on it straight away.</p>
        ) : (
          <ul className="list">
            {courses.map((course) => (
              <li key={course.id}>
                <span>
                  {course.name}
                  <br />
                  <span className="meta">
                    {course.totalHoles} holes ·{' '}
                    {course.completeness === 'par_only'
                      ? 'pars only'
                      : course.completeness === 'full'
                        ? 'full detail'
                        : 'verified'}
                    {course.teeSets > 1 ? ` · ${course.teeSets} tee sets` : ''}
                  </span>
                </span>
                <Link href={`/rounds/new?course=${course.id}`}>
                  <button type="button">Schedule a round</button>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="note">
          <Link href="/courses/new">Add a course</Link>
          {' · '}
          <Link href="/courses/new/card">Type in a scorecard</Link>
          {' · '}
          <Link href="/roster">Roster</Link>
          {' · '}
          <Link href="/standings">Standings</Link>
          {" · "}
          <Link href="/rounds">Rounds</Link>
          {' · '}
          <Link href="/dashboard">Account</Link>
        </p>
      </div>
    </>
  );
}
