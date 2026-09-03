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
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');

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
    setEvents(((await eventsResponse.json()) as { events: EventSummary[] }).events);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Start a round on this course. A round belongs to an event, so if there is no event yet
   * one is created first — the parking-lot case is someone who has just installed this and
   * wants to play, not someone who has already set up a season.
   */
  async function startRound(course: Course) {
    setBusy(course.id);
    setMessage('');

    let eventId = events[0]?.id;
    if (eventId === undefined) {
      const created = await fetch(`${apiUrl}/api/events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Casual play', year: new Date().getFullYear() }),
      });
      if (created.status === 409) {
        setBusy('');
        setMessage('Create your group first, on the Account page.');
        return;
      }
      eventId = ((await created.json()) as { id: string }).id;
    }

    const response = await fetch(`${apiUrl}/api/rounds`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        courseId: course.id,
        name: course.name,
        holeSelection: { mode: course.totalHoles === 9 ? 'front9' : 'all' },
      }),
    });
    setBusy('');

    if (!response.ok) {
      setMessage('Could not start the round.');
      return;
    }
    setMessage(`Round started on ${course.name}. ${course.totalHoles} holes, ready to score.`);
    await load();
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

  return (
    <>
      <h1>Courses</h1>
      <p className="sub">
        {courses.length === 0 ? 'None yet.' : `${courses.length} available.`}
      </p>

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
                <button
                  type="button"
                  onClick={() => void startRound(course)}
                  disabled={busy !== ''}
                >
                  {busy === course.id ? 'Starting…' : 'Start round'}
                </button>
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
