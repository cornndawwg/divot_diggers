'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface EventRow {
  id: string;
  name: string;
  year: number;
  startDate: string | null;
  endDate: string | null;
  status: string;
  playerCount: number;
  roundCount: number;
  rulesFrozen: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Being set up',
  active: 'Under way',
  completed: 'Finished',
  archived: 'Archived',
};

/** "12–15 August 2027", or as much of it as is known. */
export function describeDates(start: string | null, end: string | null): string {
  if (start === null && end === null) return 'No dates yet';
  const fmt = (iso: string, withYear: boolean): string => {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1));
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  };
  if (start !== null && end === null) return `From ${fmt(start, true)}`;
  if (start === null && end !== null) return `Until ${fmt(end, true)}`;
  if (start === end) return fmt(start as string, true);
  const sameYear = (start as string).slice(0, 4) === (end as string).slice(0, 4);
  return `${fmt(start as string, !sameYear)} – ${fmt(end as string, true)}`;
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');

  const load = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/events`, { credentials: 'include' });
    if (response.status === 401) {
      setState('signed-out');
      return;
    }
    const listed = ((await response.json()) as { events?: EventRow[] }).events ?? [];
    const detailed = await Promise.all(
      listed.map(async (event) => {
        const detail = await fetch(`${apiUrl}/api/events/${event.id}/detail`, {
          credentials: 'include',
        });
        return detail.ok ? ((await detail.json()) as EventRow) : event;
      }),
    );
    setEvents(detailed.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name)));
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'loading') return <main className="page"><p>Loading…</p></main>;
  if (state === 'signed-out')
    return (
      <main className="page">
        <h1>Signed out</h1>
        <p><Link href="/sign-in">Sign in</Link> to see your events.</p>
      </main>
    );

  return (
    <main className="page">
      <h1>Events</h1>
      <p className="hint">
        One event is one trip. Everything else — the roster, the rounds, the cup — hangs off
        whichever one you are working on.
      </p>

      <Link href="/events/new" className="button" style={{ display: 'inline-block' }}>
        Set up a new event
      </Link>

      {events.length === 0 ? (
        <div className="card" style={{ marginTop: '1rem' }}>
          <p>No events yet. Setting one up takes about a minute.</p>
        </div>
      ) : (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.7rem' }}>
          {events.map((event) => (
            <Link key={event.id} href={`/events/${event.id}`} className="card" style={{ display: 'block' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2 className="section" style={{ margin: 0 }}>{event.name}</h2>
                <span className="meta">{STATUS_LABELS[event.status] ?? event.status}</span>
              </div>
              <p className="meta" style={{ margin: '0.3rem 0 0' }}>
                {describeDates(event.startDate, event.endDate)}
              </p>
              <p className="meta" style={{ margin: '0.2rem 0 0' }}>
                {event.playerCount} on the roster · {event.roundCount}{' '}
                {event.roundCount === 1 ? 'round' : 'rounds'}
                {event.rulesFrozen ? ' · rules frozen' : ''}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
