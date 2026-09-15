'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCurrentEvent } from '../lib/current-event';

/**
 * The trip everything below belongs to, said once and changed in one place.
 *
 * Hidden where it would be noise: signed-out pages, and the pages that are about the group
 * rather than about one of its trips.
 */
const HIDDEN = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/verified',
  '/join',
  '/group',
  '/events',
  '/rulesets',
];

export function EventBar() {
  const pathname = usePathname();
  const { events, eventId, setEventId, loading, signedOut } = useCurrentEvent();

  if (signedOut || loading) return null;
  if (HIDDEN.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return null;
  }

  if (events.length === 0) {
    return (
      <div className="eventbar">
        <span className="meta">
          No event yet. <Link href="/events/new">Set one up</Link> and the roster, rounds and
          cup all hang off it.
        </span>
      </div>
    );
  }

  return (
    <div className="eventbar">
      <label htmlFor="current-event" className="meta">Event</label>
      <select
        id="current-event"
        value={eventId}
        onChange={(event) => setEventId(event.target.value)}
      >
        {events.map((event) => (
          <option key={event.id} value={event.id}>
            {event.name}
          </option>
        ))}
      </select>
      <Link href={`/events/${eventId}`} className="meta">Event details</Link>
    </div>
  );
}
