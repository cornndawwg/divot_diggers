'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface CupPlayer {
  personId: string;
  displayName: string;
  startingPtp: number;
  isCaptain: boolean;
}
interface CupTeam {
  id: string;
  key: string;
  name: string;
  captainPersonId: string | null;
  captainName: string | null;
  players: CupPlayer[];
  totalPtp: number;
}
interface Session {
  roundId: string;
  format: string;
  playersPerSide: number;
  holes: number;
  declaredMatches: number;
}
interface Balance {
  playerCount: number;
  teamsEven: boolean;
  perTeam: number;
  pointsAvailable: number;
  declaredPointsAvailable: number;
  clinchThreshold: number;
  sessions: { roundId: string; matchesThatFit: number; declaredMatches: number }[];
  issues: string[];
}
interface Cup {
  name: string;
  sessions: Session[];
  teams: CupTeam[];
  unassigned: { personId: string; displayName: string; startingPtp: number }[];
  balance: Balance;
}

const FORMAT_LABEL: Record<string, string> = {
  scramble: 'Scramble',
  alternate_shot: 'Alternate shot',
  singles: 'Singles',
  four_ball: 'Four-ball',
};

export default function CupPage() {
  const [events, setEvents] = useState<{ id: string; name: string; year: number }[]>([]);
  const [eventId, setEventId] = useState('');
  const [cup, setCup] = useState<Cup | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'none' | 'no-cup'>('loading');
  const [message, setMessage] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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
      setState('none');
      return;
    }
    const active = id ?? loaded[0]?.id ?? '';
    setEventId(active);

    const response = await fetch(`${apiUrl}/api/events/${active}/cup`, { credentials: 'include' });
    if (!response.ok) {
      setState('no-cup');
      return;
    }
    const body = (await response.json()) as Cup;
    setCup(body);
    setNames(Object.fromEntries(body.teams.map((team) => [team.id, team.name])));
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveTeam(team: CupTeam, patch: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    const response = await fetch(`${apiUrl}/api/events/${eventId}/cup/teams/${team.id}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage(((await response.json()) as { error?: string }).error ?? 'Could not save that.');
      return;
    }
    await load(eventId);
  }

  async function assign(personId: string, teamId: string | null) {
    setBusy(true);
    setMessage('');
    await fetch(`${apiUrl}/api/events/${eventId}/cup/assign`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId, teamId }),
    });
    setBusy(false);
    await load(eventId);
  }

  async function suggest() {
    setBusy(true);
    setMessage('');
    const response = await fetch(`${apiUrl}/api/events/${eventId}/cup/suggest`, {
      method: 'POST',
      credentials: 'include',
    });
    setBusy(false);
    const placed = response.ok ? ((await response.json()) as { placed: number }).placed : 0;
    setMessage(
      placed === 0
        ? 'Nobody on the roster to split.'
        : `${placed} split into two sides by target. Captains still to appoint.`,
    );
    await load(eventId);
  }

  if (state === 'loading') return <div className="card">Loading…</div>;
  if (state === 'signed-out') {
    return (
      <>
        <h1>Signed out</h1>
        <div className="card"><p className="note"><Link href="/sign-in">Sign in</Link></p></div>
      </>
    );
  }
  if (state === 'none') {
    return (
      <>
        <h1>No event yet</h1>
        <div className="card">
          <p className="note">Set one up on the <Link href="/roster">Roster</Link> page.</p>
        </div>
      </>
    );
  }
  if (state === 'no-cup' || cup === null) {
    return (
      <>
        <h1>No cup in these rules</h1>
        <div className="card">
          <p className="check fail">
            This event&apos;s rules describe no team competition, so there are no sides to set
            up. Point the event at rules that include one on the{' '}
            <Link href="/rulesets">Rules</Link> page.
          </p>
        </div>
      </>
    );
  }

  const assigned = cup.teams.reduce((sum, team) => sum + team.players.length, 0);
  const gap = Math.abs((cup.teams[0]?.totalPtp ?? 0) - (cup.teams[1]?.totalPtp ?? 0));

  return (
    <>
      <h1>{cup.name}</h1>
      <p className="sub">
        {assigned} of {cup.balance.playerCount} picked · {cup.unassigned.length} still to place
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
        {message !== '' && <p className="ok">{message}</p>}
        {cup.balance.issues.length > 0 &&
          cup.balance.issues.map((issue) => (
            <p className="check fail" key={issue}>{issue}</p>
          ))}
      </div>

      <div className="split">
        {cup.teams.map((team) => (
          <div className="card" key={team.id}>
            <div className="field">
              <label htmlFor={`name-${team.id}`}>Team name</label>
              <input
                id={`name-${team.id}`}
                value={names[team.id] ?? ''}
                onChange={(event) => setNames({ ...names, [team.id]: event.target.value })}
                onBlur={() => {
                  if ((names[team.id] ?? '') !== team.name) {
                    void saveTeam(team, { name: names[team.id] });
                  }
                }}
              />
            </div>

            <div className="field">
              <label htmlFor={`captain-${team.id}`}>Captain</label>
              <select
                id={`captain-${team.id}`}
                value={team.captainPersonId ?? ''}
                onChange={(event) => void saveTeam(team, { captainPersonId: event.target.value })}
              >
                <option value="">Nobody yet</option>
                {/* A captain plays for the side they captain, so choosing one puts them on it. */}
                {[...team.players, ...cup.unassigned].map((player) => (
                  <option key={player.personId} value={player.personId}>
                    {player.displayName}
                  </option>
                ))}
              </select>
            </div>

            <p className="totals">
              <span>{team.players.length} players</span>
              <span>Combined PTP <b>{team.totalPtp}</b></span>
            </p>

            {team.players.length === 0 ? (
              <p className="hint">Nobody on this side yet.</p>
            ) : (
              <ul className="list">
                {team.players.map((player) => (
                  <li key={player.personId}>
                    <span>
                      {player.displayName}
                      {player.isCaptain && ' · captain'}
                      <br />
                      <span className="meta">PTP {player.startingPtp}</span>
                    </span>
                    <select
                      aria-label={`Move ${player.displayName}`}
                      value={team.id}
                      disabled={busy}
                      onChange={(event) =>
                        void assign(
                          player.personId,
                          event.target.value === 'off' ? null : event.target.value,
                        )
                      }
                      style={{ maxWidth: '9rem' }}
                    >
                      {cup.teams.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                      <option value="off">Take off</option>
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {cup.teams.length === 2 && assigned > 0 && (
        <p className="hint" style={{ marginTop: '0.75rem', textAlign: 'center' }}>
          {gap === 0
            ? 'The two sides are level on combined PTP.'
            : `${gap} points of PTP between the two sides.`}
        </p>
      )}

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">Still to place</h2>
        {cup.unassigned.length === 0 ? (
          <p className="hint">Everyone on the roster has a side.</p>
        ) : (
          <ul className="list">
            {cup.unassigned.map((player) => (
              <li key={player.personId}>
                <span>
                  {player.displayName}
                  <br />
                  <span className="meta">PTP {player.startingPtp}</span>
                </span>
                {cup.teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void assign(player.personId, team.id)}
                  >
                    {team.name}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => void suggest()} disabled={busy} style={{ marginTop: '0.75rem' }}>
          {busy ? 'Working…' : 'Split them evenly by PTP'}
        </button>
        <p className="hint">
          A starting point, not a decision — it replaces both sides and appoints no captains.
        </p>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">What this roster contests</h2>
        <table className="points">
          <thead>
            <tr>
              <th>Session</th>
              <th>Format</th>
              <th>Holes</th>
              <th>Matches</th>
            </tr>
          </thead>
          <tbody>
            {cup.sessions.map((session) => {
              const fits = cup.balance.sessions.find((entry) => entry.roundId === session.roundId);
              return (
                <tr key={session.roundId}>
                  <td className="rel">{session.roundId}</td>
                  <td>{FORMAT_LABEL[session.format] ?? session.format}</td>
                  <td className="rel">{session.holes}</td>
                  <td className="score">
                    {fits?.matchesThatFit ?? session.declaredMatches}
                    {fits !== undefined && fits.matchesThatFit !== session.declaredMatches && (
                      <span className="meta"> (rules say {session.declaredMatches})</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="totals">
          <span>{cup.balance.perTeam} a side</span>
          <span>{cup.balance.pointsAvailable} points</span>
          <span><b>{cup.balance.clinchThreshold}</b> to clinch</span>
        </p>
        <p className="hint">
          Match counts come from how many turned up, not from the rules — the cup is
          {' '}{cup.balance.pointsAvailable} points this year.
        </p>
        <p className="note">
          <Link href="/roster">Roster</Link>
          {' · '}
          <Link href="/tee-times">Tee times</Link>
          {' · '}
          <Link href="/rulesets">Rules</Link>
        </p>
      </div>
    </>
  );
}
