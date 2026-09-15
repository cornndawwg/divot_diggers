'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { apiUrl } from '../../../lib/auth-client';
import { describeDates } from '../page';

interface EventDetail {
  id: string;
  groupName: string;
  name: string;
  year: number;
  startDate: string | null;
  endDate: string | null;
  status: string;
  rulesetName: string | null;
  rulesFrozen: boolean;
  playerCount: number;
  roundCount: number;
  courseCount: number;
  mayEdit: boolean;
}

/** What is still to do, in the order it makes sense to do it. */
function nextSteps(event: EventDetail): { done: boolean; label: string; href: string }[] {
  return [
    {
      done: event.startDate !== null,
      label: 'Set the dates',
      href: `/events/${event.id}`,
    },
    {
      done: event.playerCount > 0,
      label: 'Add the roster and set starting targets',
      href: '/roster',
    },
    {
      done: event.playerCount > 0,
      label: 'Invite everyone to the app',
      href: '/roster',
    },
    {
      done: event.courseCount > 0,
      label: 'Add the courses you are playing',
      href: '/courses',
    },
    {
      done: event.roundCount > 0,
      label: 'Schedule the rounds',
      href: '/rounds/new',
    },
  ];
}

export default function EventPage() {
  const id = String(useParams()['id'] ?? '');
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/events/${id}/detail`, { credentials: 'include' });
    if (!response.ok) {
      setState('missing');
      return;
    }
    const detail = (await response.json()) as EventDetail;
    setEvent(detail);
    setName(detail.name);
    setStartDate(detail.startDate ?? '');
    setEndDate(detail.endDate ?? '');
    setState('ready');
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setMessage('');
    const response = await fetch(`${apiUrl}/api/events/${id}/detail`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        ...(startDate === '' ? {} : { startDate }),
        ...(endDate === '' ? {} : { endDate }),
      }),
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error?: string }).error ?? 'Could not save.');
      return;
    }
    setEditing(false);
    await load();
  }

  if (state === 'loading') return <main className="page"><p>Loading…</p></main>;
  if (state === 'missing' || event === null)
    return (
      <main className="page">
        <h1>Not found</h1>
        <p><Link href="/events">Back to events</Link></p>
      </main>
    );

  const steps = nextSteps(event);
  const remaining = steps.filter((step) => !step.done);

  return (
    <main className="page">
      <p className="meta"><Link href="/events">Events</Link> · {event.groupName}</p>
      <h1>{event.name}</h1>
      <p className="hint">{describeDates(event.startDate, event.endDate)}</p>

      <div className="card">
        <h2 className="section">Still to do</h2>
        {remaining.length === 0 ? (
          <p>Everything is in place. This event is ready to play.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {remaining.map((step) => (
              <li key={step.label} style={{ marginBottom: '0.3rem' }}>
                <Link href={step.href}>{step.label}</Link>
              </li>
            ))}
          </ul>
        )}
        <p className="meta" style={{ marginTop: '0.6rem' }}>
          {event.playerCount} on the roster · {event.roundCount}{' '}
          {event.roundCount === 1 ? 'round' : 'rounds'} · {event.courseCount}{' '}
          {event.courseCount === 1 ? 'course' : 'courses'}
        </p>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">Details</h2>
        {!editing ? (
          <>
            <p className="meta">Year {event.year}</p>
            <p className="meta">
              Rules: {event.rulesetName ?? 'none attached'}
              {event.rulesFrozen ? ' — frozen onto this event' : ''}
            </p>
            {event.mayEdit && (
              <button type="button" className="ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="ename">Name</label>
              <input id="ename" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="estart">First day</label>
              <input id="estart" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="eend">Last day</label>
              <input id="eend" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            {message !== '' && <p className="check fail">{message}</p>}
            <div className="row">
              <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" onClick={() => void save()}>Save</button>
            </div>
          </>
        )}
      </div>

      {event.rulesFrozen && (
        <p className="hint" style={{ marginTop: '1rem' }}>
          This event&rsquo;s rules are frozen, so editing the group&rsquo;s rules will not
          change how it scores. That is what keeps last year&rsquo;s results from moving.
        </p>
      )}
    </main>
  );
}
