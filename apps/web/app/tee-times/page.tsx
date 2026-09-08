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
  /** Which cup side they play for, on a match play round. Null on a dogfight round. */
  teamKey?: string | null;
}

interface GroupingMode {
  kind: 'individual' | 'match_play';
  formatName: string | null;
  playersPerSide: number | null;
}

interface TeamRef {
  key: string;
  name: string;
  colour: string | null;
}

interface Group {
  id: string;
  sequence: number;
  teeTime: string | null;
  locked: boolean;
  players: GroupPlayer[];
}

/**
 * An individual round does not care who plays with whom — every arrangement is fair — so the
 * choice here is about pace and company, and a straight draw is a perfectly good answer.
 */
const STRATEGIES = [
  { key: 'balanced', label: 'Balanced', hint: 'A mix of strong and weak in every group.' },
  { key: 'similar', label: 'Similar', hint: 'Like with like, so each group plays at its own pace.' },
  { key: 'snake', label: 'Snake', hint: 'Strict serpentine by target, the draft ordering.' },
  { key: 'random', label: 'Random', hint: 'A straight draw out of the hat.' },
] as const;

/** A team round is a pairing, not a grouping: the only question is who plays whom. */
const PAIRINGS = [
  {
    key: 'balanced',
    label: 'Strength v strength',
    hint: 'The top pair of one side against the top pair of the other, on down.',
  },
  { key: 'random', label: 'Random draw', hint: 'Who plays whom is drawn out of the hat.' },
] as const;

/** Two sides, told apart at a glance. Overridden by whatever colour the team was given. */
const SIDE_COLOURS = ['#1d4ed8', '#b91c1c'];

export default function TeeTimesPage() {
  const [events, setEvents] = useState<{ id: string; name: string; year: number }[]>([]);
  const [eventId, setEventId] = useState('');
  const [rounds, setRounds] = useState<RoundRef[]>([]);
  const [roundId, setRoundId] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [unassigned, setUnassigned] = useState<GroupPlayer[]>([]);
  const [mode, setMode] = useState<GroupingMode>({
    kind: 'individual',
    formatName: null,
    playersPerSide: null,
  });
  const [teams, setTeams] = useState<TeamRef[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
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
    const body = (await response.json()) as {
      groups: Group[];
      unassigned: GroupPlayer[];
      mode?: GroupingMode;
      teams?: TeamRef[];
      warnings?: string[];
    };
    setGroups(body.groups);
    setUnassigned(body.unassigned);
    setMode(body.mode ?? { kind: 'individual', formatName: null, playersPerSide: null });
    setTeams(body.teams ?? []);
    setWarnings(body.warnings ?? []);
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
    const body = (await response.json()) as {
      groups?: number;
      error?: string;
      sittingOut?: string[];
    };
    if (!response.ok) {
      setMessage(body.error ?? 'Could not lay out the sheet.');
      return;
    }
    const made = body.groups ?? 0;
    const benched = body.sittingOut?.length ?? 0;
    setMessage(
      made === 0
        ? 'Nobody on this roster to group. Add players on the Roster page.'
        : `${made} ${made === 1 ? 'group' : 'groups'} suggested` +
            (benched > 0
              ? `, with ${benched} sitting out this session.`
              : '. Nothing is fixed until you lock it.'),
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

  /** Save an arrangement exactly as given. Nothing here second-guesses it. */
  async function saveArrangement(arrangement: GroupPlayer[][]) {
    setBusy(true);
    const response = await fetch(`${apiUrl}/api/rounds/${roundId}/groups`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstTeeTime: groups[0]?.teeTime ?? firstTime,
        intervalMinutes: Number(interval) || 10,
        groups: arrangement.map((players) => ({
          personIds: players.map((player) => player.personId),
        })),
      }),
    });
    setBusy(false);
    if (response.status === 409) {
      setMessage('These groupings are locked. Unlock them first.');
      return;
    }
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
    await saveArrangement(without.map((group) => group.players));
  }

  /**
   * Start from nothing: empty groups, everybody on the bench.
   *
   * Some years the pairings are argued out at the bar and simply typed in. There is no reason
   * to make somebody suggest a sheet they intend to discard before they can do that.
   */
  async function blankSheet(count: number) {
    setMessage(
      `${count} empty ${count === 1 ? 'group' : 'groups'}. Put people in them from the list below.`,
    );
    await saveArrangement(Array.from({ length: count }, () => []));
  }

  /** One more group on the end, for the year somebody turns up unannounced. */
  async function addGroup() {
    await saveArrangement([...groups.map((group) => group.players), []]);
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
  const matchPlay = mode.kind === 'match_play';
  const choices = matchPlay ? PAIRINGS : STRATEGIES;
  const chosen = choices.find((option) => option.key === strategy) ?? choices[0];

  const colourFor = (teamKey: string | null | undefined): string | null => {
    if (teamKey === null || teamKey === undefined) return null;
    const index = teams.findIndex((team) => team.key === teamKey);
    if (index < 0) return null;
    return teams[index]?.colour ?? SIDE_COLOURS[index % SIDE_COLOURS.length] ?? null;
  };

  const sideBadge = (player: GroupPlayer) => {
    const colour = colourFor(player.teamKey);
    if (colour === null) return null;
    const team = teams.find((entry) => entry.key === player.teamKey);
    return (
      <span
        title={team?.name ?? player.teamKey ?? ''}
        style={{
          display: 'inline-block',
          width: '0.55rem',
          height: '0.55rem',
          borderRadius: '50%',
          background: colour,
          marginRight: '0.45rem',
          verticalAlign: 'middle',
        }}
      />
    );
  };

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
            {matchPlay ? (
              <p className="hint" style={{ marginTop: 0 }}>
                A <b>{mode.formatName?.replace(/_/g, ' ')}</b> session, so this is a pairing
                rather than a grouping: {mode.playersPerSide} a side against{' '}
                {mode.playersPerSide} of the other team.{' '}
                {teams.length === 2 ? (
                  <>
                    {teams.map((team, index) => (
                      <span key={team.key}>
                        {index > 0 && ' v '}
                        <span style={{ color: colourFor(team.key) ?? 'inherit' }}>
                          ●
                        </span>{' '}
                        {team.name}
                      </span>
                    ))}
                    . Sides come from the <Link href="/cup">Cup</Link> page.
                  </>
                ) : (
                  <>
                    Set the two sides up on the <Link href="/cup">Cup</Link> page first.
                  </>
                )}
              </p>
            ) : (
              <p className="hint" style={{ marginTop: 0 }}>
                An individual round, so who plays with whom does not affect anybody&apos;s
                score. Group them however suits the day.
              </p>
            )}
            <div className="seg">
              {choices.map((option) => (
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
            <p className="hint">{chosen?.hint}</p>
            <div className="row" style={{ marginTop: '0.75rem' }}>
              {!matchPlay && (
                <span style={{ flex: '1 1 auto' }}>
                  <label htmlFor="size" className="meta">
                    Players a group
                  </label>
                  <input id="size" value={groupSize} onChange={(e) => setGroupSize(e.target.value)} inputMode="numeric" />
                </span>
              )}
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
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button type="button" onClick={() => void suggest()} disabled={busy || locked}>
                {busy ? 'Working…' : matchPlay ? 'Suggest pairings' : 'Suggest groupings'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void blankSheet(Math.max(1, Math.ceil((rosterSize ?? 4) / 4)))}
                disabled={busy || locked}
              >
                Start blank and do it by hand
              </button>
            </div>
            <p className="hint">
              A suggestion, not a decision. Anyone can be moved afterwards, and a captain can
              rearrange {matchPlay ? 'their own matches' : 'the sheet'} the same way. Locking is
              what makes it final.
            </p>
          </div>

          {warnings.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h2 className="section">Worth a look</h2>
              {warnings.map((warning) => (
                <p key={warning} className="check fail">
                  {warning}
                </p>
              ))}
              <p className="hint">
                Not errors. A sheet can be saved and locked exactly as it stands — this is only
                what an even draw would have done differently.
              </p>
            </div>
          )}

          {groups.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h2 className="section">The sheet</h2>
              {groups.map((group) => {
                const total = group.players.reduce((sum, player) => sum + player.startingPtp, 0);
                const split = teams
                  .map(
                    (team) =>
                      `${String(group.players.filter((p) => p.teamKey === team.key).length)}`,
                  )
                  .join(' v ');
                return (
                  <div key={group.id} style={{ marginBottom: '0.9rem' }}>
                    <p className="meta" style={{ marginBottom: '0.3rem' }}>
                      <b>{group.teeTime ?? '—'}</b> · group {group.sequence} · {group.players.length}{' '}
                      {group.players.length === 1 ? 'player' : 'players'}
                      {matchPlay && teams.length === 2 ? ` · ${split}` : ` · total ${total}`}
                    </p>
                    {group.players.length === 0 && (
                      <p className="hint" style={{ margin: '0 0 0.4rem' }}>
                        Empty — add somebody from the list below.
                      </p>
                    )}
                    <ul className="list">
                      {group.players.map((player) => (
                        <li key={player.personId}>
                          <span>
                            {sideBadge(player)}
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
                {!locked && (
                  <button type="button" className="ghost" onClick={() => void addGroup()} disabled={busy}>
                    Add a group
                  </button>
                )}
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
                      {sideBadge(player)}
                      {player.displayName}
                      <br />
                      <span className="meta">
                        PTP {player.startingPtp}
                        {matchPlay && (player.teamKey === null || player.teamKey === undefined)
                          ? ' · on neither team'
                          : ''}
                      </span>
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
