'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';
import { parseRoster, type RosterRow } from '../../lib/csv';
import { SAMPLE_ROSTER_CSV, downloadCsv } from '../../lib/samples';

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
  const [joinCode, setJoinCode] = useState<{
    code: string | null;
    expiresAt: string | null;
    expired: boolean;
  }>({ code: null, expiresAt: null, expired: false });
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
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

  // Importing a whole roster from a spreadsheet.
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<
    { name: string; status: string; detail: string }[] | null
  >(null);

  // Seeding the golfer being added to the roster.
  const [pending, setPending] = useState<ArchivedPerson | null>(null);
  const [handicap, setHandicap] = useState('');
  const [manualPtp, setManualPtp] = useState('');

  // Adjusting somebody already on the roster.
  const [editing, setEditing] = useState<RosterPlayer | null>(null);
  const [editPtp, setEditPtp] = useState('');
  const [editHandicap, setEditHandicap] = useState('');
  const [editReason, setEditReason] = useState('');
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
    void fetch(`${apiUrl}/api/events/${active}/join-code`, { credentials: 'include' })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as typeof joinCode)
          : { code: null, expiresAt: null, expired: false },
      )
      .then(setJoinCode)
      .catch(() => undefined);

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

  async function importRoster(rows: RosterRow[]) {
    setImporting(true);
    setMessage('');
    setImportResult(null);
    const response = await fetch(`${apiUrl}/api/events/${eventId}/roster/import`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    setImporting(false);
    if (!response.ok) {
      setMessage(((await response.json()) as { error?: string }).error ?? 'Could not import.');
      return;
    }
    const body = (await response.json()) as {
      rows: { name: string; status: string; detail: string }[];
      added: number;
    };
    setImportResult(body.rows);
    setMessage(`${body.added} of ${body.rows.length} added.`);
    setCsv('');
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
  function beginEdit(player: RosterPlayer) {
    setEditing(player);
    setEditPtp(String(player.startingPtp));
    setEditHandicap(player.handicapIndex === null ? '' : String(player.handicapIndex));
    setEditReason(player.overrideReason ?? '');
    setMessage('');
  }

  /**
   * Change somebody's starting target after the fact.
   *
   * A typed number is an override, so it is recorded as one with the reason beside it — the
   * 2021 to 2022 adjustments in the group's own history are exactly this, and being able to
   * see later why a number is what it is matters more than the number.
   */
  async function saveEdit(player: RosterPlayer) {
    const ptp = Number(editPtp);
    if (!Number.isFinite(ptp)) {
      setMessage('That starting target is not a number.');
      return;
    }
    const index = editHandicap.trim() === '' ? null : Number(editHandicap);
    if (index !== null && !Number.isFinite(index)) {
      setMessage('That handicap index is not a number.');
      return;
    }

    const response = await fetch(`${apiUrl}/api/events/${eventId}/players`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personId: player.personId,
        startingPtp: ptp,
        source: 'manual',
        ...(index === null ? {} : { handicapIndex: index }),
        ...(editReason.trim() === '' ? {} : { overrideReason: editReason.trim() }),
      }),
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error?: string }).error ?? 'Could not save that.');
      return;
    }
    setEditing(null);
    setMessage(`${player.displayName} set to ${ptp}.`);
    await load(eventId);
  }

  /** Put a player back on the value the rules compute for them. */
  async function resetToComputed(player: RosterPlayer) {
    const response = await fetch(`${apiUrl}/api/events/${eventId}/players`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personId: player.personId,
        ...(player.handicapIndex === null ? {} : { handicapIndex: player.handicapIndex }),
      }),
    });
    if (!response.ok) {
      setMessage('Could not work out a computed value for them.');
      return;
    }
    const body = (await response.json()) as { startingTarget: { explanation: string } };
    setEditing(null);
    setMessage(`${player.displayName}: ${body.startingTarget.explanation}`);
    await load(eventId);
  }

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

  async function issueJoinCode() {
    setCodeBusy(true);
    setCodeCopied(false);
    const response = await fetch(`${apiUrl}/api/events/${eventId}/join-code`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 30 }),
    });
    setCodeBusy(false);
    if (!response.ok) return;
    const body = (await response.json()) as { code: string };
    setJoinCode({
      code: body.code,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      expired: false,
    });
  }

  async function withdrawJoinCode() {
    setCodeBusy(true);
    setCodeCopied(false);
    await fetch(`${apiUrl}/api/events/${eventId}/join-code/clear`, {
      method: 'POST',
      credentials: 'include',
    });
    setCodeBusy(false);
    setJoinCode({ code: null, expiresAt: null, expired: false });
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
  // group admin makes, so it is made here rather than somewhere it has nothing to do with.
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
            <Link href="/tee-times">Tee times</Link>
          {' · '}
          <Link href="/courses">Courses</Link>
          {' · '}
          <Link href="/standings">Standings</Link>
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

      {roster.length === 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <p className="hint">
            Nothing else works until somebody is on this roster — a round cannot be grouped or
            scored without one. Pick from the list below, or add someone new.
          </p>
        </div>
      )}

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
              <li key={player.id} style={{ flexWrap: 'wrap' }}>
                <span>
                  {player.displayName}
                  <br />
                  <span className="meta">
                    {SOURCE_LABEL[player.startingPtpSource] ?? player.startingPtpSource}
                    {player.computedPtp !== null && player.computedPtp !== player.startingPtp
                      ? ` · rules say ${player.computedPtp}`
                      : ''}
                    {player.handicapIndex !== null ? ` · index ${player.handicapIndex}` : ''}
                    {player.phone !== null ? ` · ${player.phone}` : ''}
                  </span>
                  {player.overrideReason !== null && (
                    <>
                      <br />
                      <span className="meta">“{player.overrideReason}”</span>
                    </>
                  )}
                </span>
                <span style={{ flex: '0 0 auto', textAlign: 'right' }}>
                  <b>{player.startingPtp}</b>
                  <br />
                  <span className="meta">PTP</span>
                </span>
                <button
                  type="button"
                  onClick={() => (editing?.id === player.id ? setEditing(null) : beginEdit(player))}
                  aria-label={`Adjust ${player.displayName}`}
                >
                  {editing?.id === player.id ? 'Close' : 'Adjust'}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void removeFromRoster(player)}
                  aria-label={`Remove ${player.displayName} from the roster`}
                >
                  Remove
                </button>

                {editing?.id === player.id && (
                  <span style={{ flex: '1 1 100%', marginTop: '0.7rem' }}>
                    <div className="row">
                      <span style={{ flex: '1 1 auto' }}>
                        <label htmlFor="edit-ptp" className="meta">
                          Starting PTP
                        </label>
                        <input
                          id="edit-ptp"
                          value={editPtp}
                          inputMode="decimal"
                          onChange={(event) => setEditPtp(event.target.value)}
                        />
                      </span>
                      <span style={{ flex: '1 1 auto' }}>
                        <label htmlFor="edit-hcp" className="meta">
                          Handicap index
                        </label>
                        <input
                          id="edit-hcp"
                          value={editHandicap}
                          inputMode="decimal"
                          placeholder="optional"
                          onChange={(event) => setEditHandicap(event.target.value)}
                        />
                      </span>
                    </div>
                    <div className="field">
                      <label htmlFor="edit-why" className="meta">
                        Why (kept on the record)
                      </label>
                      <input
                        id="edit-why"
                        value={editReason}
                        placeholder="handicap has moved since last year"
                        onChange={(event) => setEditReason(event.target.value)}
                      />
                    </div>
                    <div className="row">
                      <button type="button" onClick={() => void saveEdit(player)}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void resetToComputed(player)}
                      >
                        Use what the rules compute
                      </button>
                    </div>
                  </span>
                )}
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
        <h2 className="section">Let players join themselves</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Read this out and players can add themselves from the phone app, rather than you
          typing in twenty-four people. It lets them into the group and this event as a
          player — nothing else, and it does not put them on the roster.
        </p>
        {joinCode.code === null ? (
          <button type="button" onClick={() => void issueJoinCode()} disabled={codeBusy}>
            {codeBusy ? 'Working…' : 'Create a join code'}
          </button>
        ) : (
          <>
            <p
              style={{
                fontSize: '2rem',
                fontWeight: 700,
                letterSpacing: '0.28em',
                margin: '0.3rem 0 0.2rem',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {joinCode.code}
            </p>
            <p className="meta">
              {joinCode.expired
                ? 'Expired — roll it to get a working one.'
                : joinCode.expiresAt === null
                  ? 'No expiry set.'
                  : `Works until ${new Date(joinCode.expiresAt).toLocaleDateString()}.`}
            </p>
            <div className="row" style={{ marginTop: '0.6rem' }}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(joinCode.code ?? '');
                  setCodeCopied(true);
                }}
              >
                {codeCopied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="ghost" onClick={() => void issueJoinCode()} disabled={codeBusy}>
                Roll a new one
              </button>
              <button type="button" className="ghost" onClick={() => void withdrawJoinCode()} disabled={codeBusy}>
                Withdraw
              </button>
            </div>
            <p className="hint">
              Rolling a new code stops the old one working immediately, which is what to do if
              it ends up somewhere it should not be.
            </p>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">From a spreadsheet</h2>
        <p className="hint" style={{ marginBottom: '0.6rem' }}>
          Paste rows, or choose a CSV. A header row is read if there is one — Name, Email,
          Phone, Handicap, PTP, in any order. Name is the only column that matters; leave
          Handicap blank for someone whose target you are typing, and PTP blank for a
          first-timer.
        </p>
        <p className="note" style={{ margin: '0 0 0.75rem' }}>
          <button
            type="button"
            className="link-button"
            onClick={() => downloadCsv('roster-template.csv', SAMPLE_ROSTER_CSV)}
          >
            Download a sample
          </button>
          {' · '}
          <button type="button" className="link-button" onClick={() => setCsv(SAMPLE_ROSTER_CSV)}>
            Fill this box with it
          </button>
        </p>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          aria-label="Choose a CSV file"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) setCsv(await file.text());
          }}
          style={{ marginBottom: '0.6rem' }}
        />
        <textarea
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          rows={5}
          aria-label="Paste roster rows"
          placeholder={'Name,Email,Phone,Handicap,PTP\nKenny Adkins,kenny@example.com,555-0142,,14'}
        />
        {csv.trim() !== '' && (() => {
          const parsed = parseRoster(csv);
          return (
            <>
              {parsed.problems.map((problem) => (
                <p className="check" key={problem} style={{ color: '#8a6d00' }}>
                  {problem}
                </p>
              ))}
              {parsed.rows.length > 0 && (
                <>
                  <p className="hint">
                    {parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'} read.
                    Columns used: {Object.entries(parsed.columns).map(([f, c]) => `${f} from "${c}"`).join(', ')}
                  </p>
                  <table className="points">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Phone</th>
                        <th>Hcp</th>
                        <th>PTP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.slice(0, 6).map((row, index) => (
                        <tr key={index}>
                          <td>{row.name}</td>
                          <td className="rel">{row.email ?? '—'}</td>
                          <td className="rel">{row.phone ?? '—'}</td>
                          <td className="rel">{row.handicapIndex ?? '—'}</td>
                          <td className="rel">{row.startingPtp ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsed.rows.length > 6 && (
                    <p className="hint">and {parsed.rows.length - 6} more.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void importRoster(parsed.rows)}
                    disabled={importing}
                    style={{ marginTop: '0.6rem' }}
                  >
                    {importing ? 'Importing…' : `Import ${parsed.rows.length}`}
                  </button>
                </>
              )}
            </>
          );
        })()}
        {importResult !== null && (
          <ul className="list" style={{ marginTop: '0.75rem' }}>
            {importResult.map((row, index) => (
              <li key={index}>
                <span>
                  {row.name}
                  <br />
                  <span className="meta">{row.detail}</span>
                </span>
                <span className="meta" style={{ flex: '0 0 auto' }}>
                  {row.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

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
