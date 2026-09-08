'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface RoundRef {
  id: string;
  key: string;
  name: string;
}

interface GroupPlayer {
  personId: string;
  displayName: string;
  startingPtp: number;
}

interface Group {
  id: string;
  sequence: number;
  teeTime: string | null;
  locked: boolean;
  players: GroupPlayer[];
}

const STRATEGIES = [
  { key: 'balanced', label: 'Balanced', hint: 'A mix of strong and weak in every group.' },
  { key: 'similar', label: 'Similar', hint: 'Like with like, so each group plays at its own pace.' },
  { key: 'snake', label: 'Snake', hint: 'Strict serpentine by target, the draft ordering.' },
] as const;

export default function TeeTimesPage() {
  const [events, setEvents] = useState<{ id: string; name: string; year: number }[]>([]);
  const [eventId, setEventId] = useState('');
  const [rounds, setRounds] = useState<RoundRef[]>([]);
  const [roundId, setRoundId] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [unassigned, setUnassigned] = useState<GroupPlayer[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'none'>('loading');

  const [strategy, setStrategy] = useState<string>('balanced');
  const [groupSize, setGroupSize] = useState('4');
  const [firstTime, setFirstTime] = useState('08:00');
  const [interval, setIntervalMinutes] = useState('10');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [rosterSize, setRosterSize] = useState<number | null>(null);

  const loadSheet = useCallback(async (round: string) => {
    const response = await fetch(`${apiUrl}/api/rounds/${round}/groups`, {
      credentials: 'include',
    });
    if (!response.ok) return;
    const body = (await response.json()) as { groups: Group[]; unassigned: GroupPlayer[] };
    setGroups(body.groups);
    setUnassigned(body.unassigned);
  }, []);

  const load = useCallback(
    async (event?: string, round?: string) => {
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
        setState('none');
        return;
      }
      const activeEvent = event ?? loaded[0]?.id ?? '';
      setEventId(activeEvent);

      const roundsResponse = await fetch(`${apiUrl}/api/events/${activeEvent}/rounds`, {
        credentials: 'include',
      });
      const loadedRounds = roundsResponse.ok
        ? ((await roundsResponse.json()) as { rounds: RoundRef[] }).rounds
        : [];
      setRounds(loadedRounds);

      const players = await fetch(`${apiUrl}/api/events/${activeEvent}/players`, {
        credentials: 'include',
      });
      setRosterSize(
        players.ok ? ((await players.json()) as { players: unknown[] }).players.length : null,
      );

      const activeRound = round ?? loadedRounds[0]?.id ?? '';
      setRoundId(activeRound);
      if (activeRound !== '') await loadSheet(activeRound);
      setState('ready');
    },
    [loadSheet],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function suggest() {
    setBusy(true);
    setMessage('');
    const response = await fetch(`${apiUrl}/api/rounds/${roundId}/groups`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy,
        groupSize: Number(groupSize) || 4,
        firstTeeTime: firstTime,
        intervalMinutes: Number(interval) || 10,
      }),
    });
    setBusy(false);
    if (response.status === 409) {
      setMessage('These groupings are locked. Unlock them first.');
      return;
    }
    if (!response.ok) {
      setMessage('Could not lay out the sheet.');
      return;
    }
    const made = ((await response.json()) as { groups: number }).groups;
    setMessage(
      made === 0
        ? 'Nobody on this roster to group. Add players on the Roster page.'
        : `${made} ${made === 1 ? 'group' : 'groups'} suggested. Nothing is fixed until you lock it.`,
    );
    await loadSheet(roundId);
  }

  async function setLocked(locked: boolean) {
    await fetch(`${apiUrl}/api/rounds/${roundId}/groups/lock`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked }),
    });
    setMessage(locked ? 'Locked.' : 'Unlocked — you can rearrange again.');
    await loadSheet(roundId);
  }

  /** Move one player between groups, then save the whole sheet. */
  async function move(personId: string, toSequence: number | null) {
    const without = groups.map((group) => ({
      ...group,
      players: group.players.filter((player) => player.personId !== personId),
    }));
    if (toSequence !== null) {
      const target = without.find((group) => group.sequence === toSequence);
      const player =
        groups.flatMap((group) => group.players).find((p) => p.personId === personId) ??
        unassigned.find((p) => p.personId === personId);
      if (target !== undefined && player !== undefined) target.players.push(player);
    }

    await fetch(`${apiUrl}/api/rounds/${roundId}/groups`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstTeeTime: without[0]?.teeTime ?? firstTime,
        intervalMinutes: Number(interval) || 10,
        groups: without.map((group) => ({
          personIds: group.players.map((player) => player.personId),
        })),
      }),
    });
    await loadSheet(roundId);
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
  if (state === 'none') {
    return (
      <>
        <h1>No event yet</h1>
        <div className="card">
          <p className="note">
            Set one up on the <Link href="/roster">Roster</Link> page.
          </p>
        </div>
      </>
    );
  }

  const locked = groups.length > 0 && groups.every((group) => group.locked);

  return (
    <>
      <h1>Tee times</h1>
      <p className="sub">
        {groups.length} {groups.length === 1 ? 'group' : 'groups'}
        {locked ? ' · locked' : ''}
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
        {rosterSize === 0 && (
          <p className="check fail">
            Nobody is on this event&apos;s roster, so there is nobody to group. Add players on
            the <Link href="/roster">Roster</Link> page.
          </p>
        )}
        {rounds.length === 0 ? (
          <p className="check fail">
            This event has no rounds yet. Start one from <Link href="/courses">Courses</Link>,
            making sure you pick this event.
          </p>
        ) : (
          <div className="field">
            <label htmlFor="round">Round</label>
            <select
              id="round"
              value={roundId}
              onChange={(changed) => {
                setRoundId(changed.target.value);
                void loadSheet(changed.target.value);
              }}
            >
              {rounds.map((round) => (
                <option key={round.id} value={round.id}>
                  {round.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {message !== '' && <p className="ok">{message}</p>}
      </div>

      {rounds.length > 0 && rosterSize !== 0 && (
        <>
          <div className="card">
            <h2 className="section">Lay out the sheet</h2>
            <div className="seg">
              {STRATEGIES.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={strategy === option.key}
                  onClick={() => setStrategy(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="hint">
              {STRATEGIES.find((option) => option.key === strategy)?.hint}
            </p>
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <span style={{ flex: '1 1 auto' }}>
                <label htmlFor="size" className="meta">
                  Players a group
                </label>
                <input id="size" value={groupSize} onChange={(e) => setGroupSize(e.target.value)} inputMode="numeric" />
              </span>
              <span style={{ flex: '1 1 auto' }}>
                <label htmlFor="first" className="meta">
                  First tee time
                </label>
                <input id="first" value={firstTime} onChange={(e) => setFirstTime(e.target.value)} placeholder="08:00" />
              </span>
              <span style={{ flex: '1 1 auto' }}>
                <label htmlFor="gap" className="meta">
                  Minutes apart
                </label>
                <input id="gap" value={interval} onChange={(e) => setIntervalMinutes(e.target.value)} inputMode="numeric" />
              </span>
            </div>
            <button type="button" onClick={() => void suggest()} disabled={busy || locked} style={{ marginTop: '0.75rem' }}>
              {busy ? 'Working…' : 'Suggest groupings'}
            </button>
            <p className="hint">
              A suggestion, not a decision. Move anyone you like, then lock it.
            </p>
          </div>

          {groups.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h2 className="section">The sheet</h2>
              {groups.map((group) => {
                const total = group.players.reduce((sum, player) => sum + player.startingPtp, 0);
                return (
                  <div key={group.id} style={{ marginBottom: '0.9rem' }}>
                    <p className="meta" style={{ marginBottom: '0.3rem' }}>
                      <b>{group.teeTime ?? '—'}</b> · group {group.sequence} · {group.players.length}{' '}
                      {group.players.length === 1 ? 'player' : 'players'} · total {total}
                    </p>
                    <ul className="list">
                      {group.players.map((player) => (
                        <li key={player.personId}>
                          <span>
                            {player.displayName}
                            <br />
                            <span className="meta">PTP {player.startingPtp}</span>
                          </span>
                          {!locked && (
                            <select
                              aria-label={`Move ${player.displayName}`}
                              value={group.sequence}
                              onChange={(changed) =>
                                void move(
                                  player.personId,
                                  changed.target.value === 'out' ? null : Number(changed.target.value),
                                )
                              }
                              style={{ maxWidth: '9rem' }}
                            >
                              {groups.map((option) => (
                                <option key={option.id} value={option.sequence}>
                                  {option.teeTime ?? `Group ${option.sequence}`}
                                </option>
                              ))}
                              <option value="out">Take out</option>
                            </select>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}

              <div className="row" style={{ marginTop: '0.5rem' }}>
                <button type="button" onClick={() => void setLocked(!locked)}>
                  {locked ? 'Unlock' : 'Lock the sheet'}
                </button>
              </div>
              <p className="hint">
                Locking is what stops it moving the night before. Unlock to change anything.
              </p>
            </div>
          )}

          {unassigned.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h2 className="section">Not out yet</h2>
              <ul className="list">
                {unassigned.map((player) => (
                  <li key={player.personId}>
                    <span>
                      {player.displayName}
                      <br />
                      <span className="meta">PTP {player.startingPtp}</span>
                    </span>
                    {!locked && groups.length > 0 && (
                      <select
                        aria-label={`Put ${player.displayName} in a group`}
                        value=""
                        onChange={(changed) => void move(player.personId, Number(changed.target.value))}
                        style={{ maxWidth: '9rem' }}
                      >
                        <option value="">Put in…</option>
                        {groups.map((option) => (
                          <option key={option.id} value={option.sequence}>
                            {option.teeTime ?? `Group ${option.sequence}`}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="note">
            <Link href="/roster">Roster</Link>
            {' · '}
            <Link href="/standings">Standings</Link>
            {' · '}
            <Link href="/courses">Courses</Link>
          </p>
        </>
      )}
    </>
  );
}
