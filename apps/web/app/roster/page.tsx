'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface ArchivedPerson {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  lastYear: number | null;
  eventsPlayed: number;
  lastRating: { raw: number; rounded: number; year: number | null } | null;
  onRoster: boolean;
}

interface RosterPlayer {
  id: string;
  personId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  handicapIndex: number | null;
  startingPtp: number;
  startingPtpSource: string;
  computedPtp: number | null;
  overrideReason: string | null;
}

interface Balance {
  playerCount: number;
  teamsEven: boolean;
  perTeam: number;
  pointsAvailable: number;
  declaredPointsAvailable: number;
  clinchThreshold: number;
  issues: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  carried: 'carried forward',
  seeded_from_handicap: 'from handicap',
  lapsed_adjusted: 'returning player',
  manual: 'set by hand',
};

export default function RosterPage() {
  const [eventId, setEventId] = useState('');
  const [events, setEvents] = useState<{ id: string; name: string; year: number }[]>([]);
  const [newEventName, setNewEventName] = useState('');
  const [newEventYear, setNewEventYear] = useState(String(new Date().getFullYear()));
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [archive, setArchive] = useState<ArchivedPerson[]>([]);
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'no-event'>('loading');
  const [message, setMessage] = useState('');

  // Adding a golfer who is not in the archive yet.
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');

  // Seeding the golfer being added to the roster.
  const [pending, setPending] = useState<ArchivedPerson | null>(null);
  const [handicap, setHandicap] = useState('');
  const [manualPtp, setManualPtp] = useState('');
  const [removed, setRemoved] = useState<ArchivedPerson[]>([]);
  const [showRemoved, setShowRemoved] = useState(false);

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
      setState('no-event');
      return;
    }
    const active = id ?? loaded[0]?.id ?? '';
    setEventId(active);

    const [archiveResponse, rosterResponse, balanceResponse] = await Promise.all([
      fetch(`${apiUrl}/api/people?eventId=${active}`, { credentials: 'include' }),
      fetch(`${apiUrl}/api/events/${active}/players`, { credentials: 'include' }),
      fetch(`${apiUrl}/api/events/${active}/roster-balance`, { credentials: 'include' }),
    ]);
    setArchive(((await archiveResponse.json()) as { people: ArchivedPerson[] }).people);
    const removedResponse = await fetch(`${apiUrl}/api/people?removed=true`, {
      credentials: 'include',
    });
    setRemoved(((await removedResponse.json()) as { people: ArchivedPerson[] }).people);
    setRoster(((await rosterResponse.json()) as { players: RosterPlayer[] }).players);
    setBalance(balanceResponse.ok ? ((await balanceResponse.json()) as Balance) : null);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createEvent() {
    setMessage('');
    setCreatingEvent(true);
    const response = await fetch(`${apiUrl}/api/events`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newEventName.trim(),
        year: Number(newEventYear) || new Date().getFullYear(),
      }),
    });
    setCreatingEvent(false);

    if (response.status === 409) {
      setMessage('Create your group first, on the Account page.');
      return;
    }
    if (!response.ok) {
      setMessage('Could not create the event.');
      return;
    }
    const created = (await response.json()) as { id: string };
    setNewEventName('');
    await load(created.id);
  }

  async function addToArchive() {
    if (newName.trim() === '') return;
    await fetch(`${apiUrl}/api/people`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), email: newEmail.trim(), phone: newPhone.trim() }),
    });
    setNewName('');
    setNewEmail('');
    setNewPhone('');
    setMessage(`${newName.trim()} saved. They will be on this list next year too.`);
    await load(eventId);
  }

  async function addToRoster(person: ArchivedPerson) {
    setMessage('');
    const index = Number(handicap);
    const manual = Number(manualPtp);

    const body: Record<string, unknown> = { personId: person.id };
    if (manualPtp.trim() !== '' && Number.isFinite(manual)) {
      body['startingPtp'] = manual;
      body['source'] = 'manual';
    } else if (handicap.trim() !== '' && Number.isFinite(index)) {
      body['handicapIndex'] = index;
      body['source'] = person.lastRating === null ? 'seeded_from_handicap' : undefined;
    }

    const response = await fetch(`${apiUrl}/api/events/${eventId}/players`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const failure = (await response.json()) as { error?: string };
      setMessage(failure.error ?? 'Could not add them.');
      return;
    }
    const added = (await response.json()) as { startingTarget: { explanation: string } };
    setMessage(`${person.displayName}: ${added.startingTarget.explanation}`);
    setPending(null);
    setHandicap('');
    setManualPtp('');
    await load(eventId);
  }

  /** Take someone off this year's roster. Refused once they have been scored. */
  async function removeFromRoster(player: RosterPlayer) {
    setMessage('');
    const response = await fetch(`${apiUrl}/api/events/${eventId}/players/${player.personId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error: string }).error);
      return;
    }
    setMessage(`${player.displayName} is off the roster. They are still in the archive.`);
    await load(eventId);
  }

  /** Remove from the archive. Soft: their rating history survives. */
  async function removeFromArchive(person: ArchivedPerson) {
    setMessage('');
    const response = await fetch(`${apiUrl}/api/people/${person.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error: string }).error);
      return;
    }
    setMessage(`${person.displayName} removed from the archive. Their history is kept.`);
    await load(eventId);
  }

  async function restore(person: ArchivedPerson) {
    await fetch(`${apiUrl}/api/people/${person.id}/restore`, {
      method: 'POST',
      credentials: 'include',
    });
    setMessage(`${person.displayName} is back, with their rating history.`);
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
  // An event is a trip: a name and a year, with a roster inside it. It is the first thing a
  // planner makes, so it is made here rather than somewhere it has nothing to do with.
  const eventForm = (
    <div className="field">
      <div className="row">
        <input
          value={newEventName}
          onChange={(event) => setNewEventName(event.target.value)}
          placeholder="Divot Diggers 2027"
          aria-label="Event name"
        />
        <input
          value={newEventYear}
          onChange={(event) => setNewEventYear(event.target.value)}
          inputMode="numeric"
          aria-label="Year"
          style={{ maxWidth: '6rem' }}
        />
        <button
          type="button"
          onClick={() => void createEvent()}
          disabled={creatingEvent || newEventName.trim() === ''}
        >
          {creatingEvent ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  );

  if (state === 'no-event') {
    return (
      <>
        <h1>Set up your event</h1>
        <p className="sub">A trip, with a roster inside it. Name it and pick the year.</p>
        <div className="card">
          {message !== '' && <p className="error">{message}</p>}
          {eventForm}
          <p className="note">
            <Link href="/dashboard">Account</Link>
            {' · '}
            <Link href="/courses">Courses</Link>
          </p>
        </div>
      </>
    );
  }

  const available = archive.filter((person) => !person.onRoster);

  return (
    <>
      <h1>Roster</h1>
      <p className="sub">
        {roster.length} {roster.length === 1 ? 'player' : 'players'}
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
        <details>
          <summary className="hint" style={{ cursor: 'pointer' }}>
            Add another event
          </summary>
          <div style={{ marginTop: '0.6rem' }}>{eventForm}</div>
        </details>
      </div>

      {balance !== null && balance.issues.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          {/* Roster size drives the whole cup, so say so early rather than at the draft. */}
          {balance.issues.map((issue) => (
            <p className="check fail" key={issue}>
              {issue}
            </p>
          ))}
          <p className="hint">
            {balance.playerCount} players · {balance.perTeam} a team ·{' '}
            {balance.pointsAvailable} points contested, {balance.clinchThreshold} to clinch
          </p>
        </div>
      )}

      <div className="card">
        {message !== '' && <p className="ok">{message}</p>}

        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>On the roster</h2>
        {roster.length === 0 ? (
          <p className="hint">Nobody yet. Pick from the list below.</p>
        ) : (
          <ul className="list">
            {roster.map((player) => (
              <li key={player.id}>
                <span>
                  {player.displayName}
                  <br />
                  <span className="meta">
                    {SOURCE_LABEL[player.startingPtpSource] ?? player.startingPtpSource}
                    {player.computedPtp !== null && player.computedPtp !== player.startingPtp
                      ? ` · computed ${player.computedPtp}`
                      : ''}
                    {player.phone !== null ? ` · ${player.phone}` : ''}
                  </span>
                </span>
                <span style={{ flex: '0 0 auto', textAlign: 'right' }}>
                  <b>{player.startingPtp}</b>
                  <br />
                  <span className="meta">PTP</span>
                </span>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void removeFromRoster(player)}
                  aria-label={`Remove ${player.displayName} from the roster`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Choose from previous years</h2>
        {available.length === 0 ? (
          <p className="hint">Everyone in the archive is already on this roster.</p>
        ) : (
          <ul className="list">
            {available.map((person) => (
              <li key={person.id} style={{ flexWrap: 'wrap' }}>
                <span>
                  {person.displayName}
                  <br />
                  <span className="meta">
                    {person.lastRating !== null
                      ? `last PTP ${person.lastRating.rounded}`
                      : 'no rating on file'}
                    {person.lastYear !== null ? ` · last played ${person.lastYear}` : ''}
                    {person.phone !== null ? ` · ${person.phone}` : ''}
                    {person.email !== null ? ` · ${person.email}` : ''}
                  </span>
                </span>
                {pending?.id === person.id ? (
                  <span style={{ flex: '1 1 100%', marginTop: '0.6rem' }}>
                    <div className="row">
                      <input
                        value={handicap}
                        onChange={(event) => setHandicap(event.target.value)}
                        placeholder="Handicap index"
                        inputMode="decimal"
                        aria-label="Handicap index"
                      />
                      <input
                        value={manualPtp}
                        onChange={(event) => setManualPtp(event.target.value)}
                        placeholder="Or set PTP"
                        inputMode="decimal"
                        aria-label="Starting PTP"
                      />
                      <button type="button" onClick={() => void addToRoster(person)}>
                        Add
                      </button>
                    </div>
                    <p className="hint">
                      {person.lastRating !== null
                        ? `Leave both blank to carry ${person.lastRating.rounded} forward.`
                        : 'A first-timer needs a handicap index, or a target set by hand.'}
                    </p>
                  </span>
                ) : (
                  <>
                    <button type="button" onClick={() => setPending(person)}>
                      Add
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void removeFromArchive(person)}
                      aria-label={`Remove ${person.displayName} from the archive`}
                    >
                      Archive off
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {removed.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="link-button"
            onClick={() => setShowRemoved(!showRemoved)}
          >
            {showRemoved ? 'Hide' : 'Show'} {removed.length} removed{' '}
            {removed.length === 1 ? 'golfer' : 'golfers'}
          </button>
          {showRemoved && (
            <ul className="list" style={{ marginTop: '0.75rem' }}>
              {removed.map((person) => (
                <li key={person.id}>
                  <span>
                    {person.displayName}
                    <br />
                    <span className="meta">
                      {person.lastRating !== null
                        ? `PTP ${person.lastRating.rounded} kept`
                        : 'no rating on file'}
                    </span>
                  </span>
                  <button type="button" onClick={() => void restore(person)}>
                    Put back
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Someone new</h2>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Saved to the list above, so you only type this once.
        </p>
        <div className="field">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" aria-label="Name" />
        </div>
        <div className="field">
          <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email (optional)" aria-label="Email" />
        </div>
        <div className="field">
          <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (optional)" aria-label="Phone" />
        </div>
        <button type="button" onClick={() => void addToArchive()}>
          Save to the archive
        </button>
        <p className="note">
          <Link href="/courses">Courses</Link>
          {' · '}
          <Link href="/rounds">Rounds</Link>
          {' · '}
          <Link href="/dashboard">Account</Link>
        </p>
      </div>
    </>
  );
}
