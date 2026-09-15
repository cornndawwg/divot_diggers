'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { apiUrl } from '../../../lib/auth-client';
import { describeDates } from '../page';

interface Trip {
  notes: string | null;
  currency: string;
  mayEdit: boolean;
  costs: { id: string; label: string; amount: number | null; perPlayer: boolean; note: string | null }[];
  roster: { personId: string; displayName: string }[];
  payments: { personId: string; displayName: string; category: string; paid: boolean; note: string | null }[];
}

/** Minor units in, something a person reads out. */
function money(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
}

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
  const [trip, setTrip] = useState<Trip | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [costDraft, setCostDraft] = useState<
    { label: string; amount: string; perPlayer: boolean; note: string }[]
  >([]);
  const [editingCosts, setEditingCosts] = useState(false);

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

    const tripResponse = await fetch(`${apiUrl}/api/events/${id}/trip`, { credentials: 'include' });
    if (tripResponse.ok) {
      const loaded = (await tripResponse.json()) as Trip;
      setTrip(loaded);
      setNotesDraft(loaded.notes ?? '');
      setCostDraft(
        loaded.costs.map((cost) => ({
          label: cost.label,
          amount: cost.amount === null ? '' : (cost.amount / 100).toFixed(2),
          perPlayer: cost.perPlayer,
          note: cost.note ?? '',
        })),
      );
    }
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

  async function saveNotes() {
    await fetch(`${apiUrl}/api/events/${id}/trip/notes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesDraft }),
    });
    setEditingNotes(false);
    await load();
  }

  async function saveCosts() {
    await fetch(`${apiUrl}/api/events/${id}/trip/costs`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: costDraft
          .filter((line) => line.label.trim() !== '')
          .map((line) => ({
            label: line.label.trim(),
            // Entered in whole currency, stored in minor units — rounded here so a stray
            // third decimal cannot become a fraction of a penny in the database.
            amount: line.amount.trim() === '' ? null : Math.round(Number(line.amount) * 100),
            perPlayer: line.perPlayer,
            note: line.note.trim(),
          })),
      }),
    });
    setEditingCosts(false);
    await load();
  }

  async function markPaid(personId: string, category: string, paid: boolean) {
    await fetch(`${apiUrl}/api/events/${id}/trip/paid`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId, category, paid }),
    });
    await load();
  }

  function paidFor(personId: string, category: string): boolean {
    return trip?.payments.some(
      (p) => p.personId === personId && p.category === category && p.paid,
    ) === true;
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

      {trip !== null && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h2 className="section">The trip</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Everything a welcome packet used to say — where you are staying, what time
            Thursday starts, who to pay. Every player in the group can read this.
          </p>
          {!editingNotes ? (
            <>
              {trip.notes === null || trip.notes.trim() === '' ? (
                <p className="meta">Nothing written yet.</p>
              ) : (
                // Plain text, rendered as written. No markup is interpreted, so nothing
                // anybody types can become anything but words on a page.
                <p style={{ whiteSpace: 'pre-wrap' }}>{trip.notes}</p>
              )}
              {trip.mayEdit && (
                <button type="button" className="ghost" onClick={() => setEditingNotes(true)}>
                  {trip.notes === null || trip.notes === '' ? 'Write it' : 'Edit'}
                </button>
              )}
            </>
          ) : (
            <>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={12}
                style={{ width: '100%', fontFamily: 'inherit', fontSize: '1rem', padding: '0.6rem' }}
                placeholder={'Thursday: first tee 8:10 at Heathland.\nStaying at the Marina Inn.\nPay Levi by 1 July.'}
              />
              <div className="row">
                <button type="button" className="ghost" onClick={() => setEditingNotes(false)}>Cancel</button>
                <button type="button" onClick={() => void saveNotes()}>Save</button>
              </div>
            </>
          )}
        </div>
      )}

      {trip !== null && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h2 className="section">What it costs</h2>
          {!editingCosts ? (
            <>
              {trip.costs.length === 0 ? (
                <p className="meta">No breakdown yet.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {trip.costs.map((cost) => (
                      <tr key={cost.id}>
                        <td style={{ padding: '0.35rem 0' }}>
                          {cost.label}
                          {cost.note !== null && <span className="meta"> — {cost.note}</span>}
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {money(cost.amount, trip.currency)}
                        </td>
                        <td className="meta" style={{ textAlign: 'right', paddingLeft: '0.8rem' }}>
                          {cost.amount === null ? '' : cost.perPlayer ? 'each' : 'total'}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ paddingTop: '0.5rem', borderTop: '1px solid #ddd' }}>
                        <b>Each player</b>
                      </td>
                      <td style={{
                        paddingTop: '0.5rem', borderTop: '1px solid #ddd',
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      }}>
                        <b>
                          {money(
                            trip.costs
                              .filter((c) => c.perPlayer && c.amount !== null)
                              .reduce((sum, c) => sum + (c.amount ?? 0), 0),
                            trip.currency,
                          )}
                        </b>
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              )}
              {trip.mayEdit && (
                <button type="button" className="ghost" onClick={() => setEditingCosts(true)}>
                  Edit the breakdown
                </button>
              )}
            </>
          ) : (
            <>
              {costDraft.map((line, index) => (
                <div className="row" key={index} style={{ marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                  <input
                    value={line.label}
                    placeholder="What it is"
                    onChange={(e) =>
                      setCostDraft(costDraft.map((l, i) => (i === index ? { ...l, label: e.target.value } : l)))
                    }
                    style={{ flex: '2 1 12rem' }}
                  />
                  <input
                    value={line.amount}
                    placeholder="0.00"
                    inputMode="decimal"
                    onChange={(e) =>
                      setCostDraft(costDraft.map((l, i) => (i === index ? { ...l, amount: e.target.value } : l)))
                    }
                    style={{ flex: '0 1 7rem' }}
                  />
                  <label className="meta" style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={line.perPlayer}
                      onChange={(e) =>
                        setCostDraft(costDraft.map((l, i) => (i === index ? { ...l, perPlayer: e.target.checked } : l)))
                      }
                    />
                    each
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setCostDraft(costDraft.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="row">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setCostDraft([...costDraft, { label: '', amount: '', perPlayer: true, note: '' }])}
                >
                  Add a line
                </button>
                <button type="button" className="ghost" onClick={() => setEditingCosts(false)}>Cancel</button>
                <button type="button" onClick={() => void saveCosts()}>Save</button>
              </div>
            </>
          )}
        </div>
      )}

      {trip !== null && trip.mayEdit && trip.roster.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h2 className="section">Who has settled up</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            A checklist, not a ledger — the app holds no money and works out no balances.
            Only you and the other admins see this; each player sees their own line and
            nobody else&rsquo;s.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }} className="meta">Player</th>
                <th className="meta">Trip</th>
                <th className="meta">Wager</th>
              </tr>
            </thead>
            <tbody>
              {trip.roster.map((player) => (
                <tr key={player.personId}>
                  <td style={{ padding: '0.35rem 0' }}>{player.displayName}</td>
                  {(['trip', 'wager'] as const).map((category) => (
                    <td key={category} style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`${player.displayName} has paid the ${category}`}
                        checked={paidFor(player.personId, category)}
                        onChange={(e) => void markPaid(player.personId, category, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {event.rulesFrozen && (
        <p className="hint" style={{ marginTop: '1rem' }}>
          This event&rsquo;s rules are frozen, so editing the group&rsquo;s rules will not
          change how it scores. That is what keeps last year&rsquo;s results from moving.
        </p>
      )}
    </main>
  );
}
