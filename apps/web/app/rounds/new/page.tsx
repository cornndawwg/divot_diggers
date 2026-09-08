'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiUrl } from '../../../lib/auth-client';

/**
 * Scheduling a round, step by step.
 *
 * "Start round" used to do this in one click and explain none of it, which left planners with
 * rounds attached to the wrong event and no idea a tee set or a hole selection had been picked
 * for them. Each decision is now visible, has a default, and says what it affects.
 */

interface EventSummary {
  id: string;
  name: string;
  year: number;
}
interface CourseSummary {
  id: string;
  name: string;
  totalHoles: number;
  completeness: string;
}
interface TeeSet {
  id: string;
  name: string;
  gender: string;
  courseRating: number | null;
  slopeRating: number | null;
  parTotal: number | null;
  yardageTotal: number | null;
  holes: number;
}
interface RulesetRound {
  key: string;
  name: string;
  competitions: string[];
  holes: number | null;
}

const HOLE_CHOICES = [
  { mode: 'all', label: 'All 18' },
  { mode: 'front9', label: 'Front nine' },
  { mode: 'back9', label: 'Back nine' },
] as const;

function ScheduleRound() {
  const router = useRouter();

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [rulesetRounds, setRulesetRounds] = useState<RulesetRound[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'blocked'>('loading');
  const [blocker, setBlocker] = useState('');

  const [eventId, setEventId] = useState('');
  const [rosterSize, setRosterSize] = useState(0);
  const [courseId, setCourseId] = useState('');
  const [teeSets, setTeeSets] = useState<TeeSet[]>([]);
  const [teeSetId, setTeeSetId] = useState('');
  const [holeMode, setHoleMode] = useState<'all' | 'front9' | 'back9'>('all');
  const [roundKey, setRoundKey] = useState('');
  const [name, setName] = useState('');
  const [playedOn, setPlayedOn] = useState('');

  const [makeSheet, setMakeSheet] = useState(true);
  const [strategy, setStrategy] = useState('balanced');
  const [groupSize, setGroupSize] = useState('4');
  const [firstTime, setFirstTime] = useState('08:00');
  const [interval, setIntervalMinutes] = useState('10');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [eventsResponse, coursesResponse] = await Promise.all([
      fetch(`${apiUrl}/api/events`, { credentials: 'include' }),
      fetch(`${apiUrl}/api/courses`, { credentials: 'include' }),
    ]);
    if (eventsResponse.status === 401) {
      setState('signed-out');
      return;
    }
    const loadedEvents = ((await eventsResponse.json()) as { events: EventSummary[] }).events;
    const loadedCourses = ((await coursesResponse.json()) as { courses: CourseSummary[] }).courses;
    setEvents(loadedEvents);
    setCourses(loadedCourses);

    if (loadedEvents.length === 0) {
      setBlocker('You need an event first. Create one on the Roster page.');
      setState('blocked');
      return;
    }
    if (loadedCourses.length === 0) {
      setBlocker('You need a course first. Add one on the Courses page.');
      setState('blocked');
      return;
    }

    const firstEvent = loadedEvents[0]?.id ?? '';
    setEventId(firstEvent);
    setCourseId(loadedCourses[0]?.id ?? '');
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** What the event's rules expect: which round ids exist and which competitions use them. */
  useEffect(() => {
    if (eventId === '') return;
    let cancelled = false;
    void (async () => {
      const [players, rounds, rulesets] = await Promise.all([
        fetch(`${apiUrl}/api/events/${eventId}/players`, { credentials: 'include' }),
        fetch(`${apiUrl}/api/events/${eventId}/rounds`, { credentials: 'include' }),
        fetch(`${apiUrl}/api/rulesets`, { credentials: 'include' }),
      ]);
      if (cancelled) return;
      setRosterSize(
        players.ok ? ((await players.json()) as { players: unknown[] }).players.length : 0,
      );
      const existing = rounds.ok
        ? ((await rounds.json()) as { rounds: { key: string }[] }).rounds.map((r) => r.key)
        : [];

      // Round ids come from the ruleset, and they are what says which competitions a round
      // feeds. Offering them by name beats asking a planner to invent a key.
      const list = rulesets.ok
        ? ((await rulesets.json()) as { rulesets: { id: string }[] }).rulesets
        : [];
      const newest = list[0]?.id;
      if (newest === undefined) {
        setRulesetRounds([]);
        return;
      }
      const detail = await fetch(`${apiUrl}/api/rulesets/${newest}`, { credentials: 'include' });
      if (!detail.ok) {
        setRulesetRounds([]);
        return;
      }
      const document = ((await detail.json()) as { document: Record<string, unknown> }).document;
      const competitions = (document['competitions'] ?? []) as Record<string, unknown>[];
      const map = new Map<string, RulesetRound>();
      for (const competition of competitions) {
        const label = String(competition['name'] ?? competition['id']);
        if (competition['type'] === 'individual_target') {
          for (const key of (competition['rounds'] ?? []) as string[]) {
            const found = map.get(key) ?? { key, name: key, competitions: [], holes: null };
            found.competitions.push(label);
            map.set(key, found);
          }
        }
        if (competition['type'] === 'team_match_play') {
          for (const session of (competition['sessions'] ?? []) as Record<string, unknown>[]) {
            const key = String(session['roundId']);
            const found = map.get(key) ?? { key, name: key, competitions: [], holes: null };
            found.competitions.push(label);
            found.holes = typeof session['holes'] === 'number' ? session['holes'] : null;
            map.set(key, found);
          }
        }
      }
      const available = [...map.values()].filter((round) => !existing.includes(round.key));
      setRulesetRounds(available);
      const first = available[0];
      if (first !== undefined) {
        setRoundKey(first.key);
        setName(first.key);
        if (first.holes === 9) setHoleMode('front9');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  /** Tee sets for the chosen course. */
  useEffect(() => {
    if (courseId === '') return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${apiUrl}/api/courses/${courseId}`, {
        credentials: 'include',
      });
      if (cancelled || !response.ok) return;
      const body = (await response.json()) as { teeSets: TeeSet[] };
      setTeeSets(body.teeSets);
      setTeeSetId(body.teeSets[0]?.id ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const chosenRound = useMemo(
    () => rulesetRounds.find((round) => round.key === roundKey),
    [rulesetRounds, roundKey],
  );
  const chosenTee = useMemo(() => teeSets.find((tee) => tee.id === teeSetId), [teeSets, teeSetId]);
  const chosenCourse = useMemo(
    () => courses.find((course) => course.id === courseId),
    [courses, courseId],
  );
  const holesInPlay = holeMode === 'all' ? (chosenTee?.holes ?? 18) : 9;
  const groupCount = Math.ceil(rosterSize / (Number(groupSize) || 4));

  async function schedule() {
    setError('');
    if (roundKey.trim() === '') {
      setError('Choose which round of the event this is.');
      return;
    }
    setBusy(true);

    const response = await fetch(`${apiUrl}/api/rounds`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        courseId,
        teeSetId,
        key: roundKey.trim(),
        name: name.trim() === '' ? roundKey.trim() : name.trim(),
        holeSelection: { mode: holeMode },
        ...(playedOn === '' ? {} : { playedOn }),
      }),
    });

    if (!response.ok) {
      setBusy(false);
      setError(((await response.json()) as { error?: string }).error ?? 'Could not schedule it.');
      return;
    }
    const round = (await response.json()) as { id: string };

    if (makeSheet && rosterSize > 0) {
      await fetch(`${apiUrl}/api/rounds/${round.id}/groups`, {
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
    }
    setBusy(false);
    router.push('/rounds');
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
  if (state === 'blocked') {
    return (
      <>
        <h1>Not yet</h1>
        <div className="card">
          <p className="check fail">{blocker}</p>
          <p className="note">
            <Link href="/roster">Roster</Link>
            {' · '}
            <Link href="/courses">Courses</Link>
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Schedule a round</h1>
      <p className="sub">Four decisions, each with a sensible default.</p>

      <div className="card">
        <h2 className="section">1 · Which round of which event</h2>
        <p className="hint">
          A round belongs to an event, and its round id is what tells the rules how to score
          it.
        </p>
        <div className="field">
          <label htmlFor="event">Event</label>
          <select id="event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.name} ({event.year})
              </option>
            ))}
          </select>
          <p className="hint">
            {rosterSize} {rosterSize === 1 ? 'player' : 'players'} on this roster.
            {rosterSize === 0 && ' Nobody can be grouped or scored until somebody is on it.'}
          </p>
        </div>

        {rulesetRounds.length > 0 ? (
          <div className="field">
            <label htmlFor="key">Round</label>
            <select
              id="key"
              value={roundKey}
              onChange={(e) => {
                setRoundKey(e.target.value);
                setName(e.target.value);
                const found = rulesetRounds.find((round) => round.key === e.target.value);
                if (found?.holes === 9) setHoleMode('front9');
              }}
            >
              {rulesetRounds.map((round) => (
                <option key={round.key} value={round.key}>
                  {round.key} — {round.competitions.join(' and ')}
                </option>
              ))}
            </select>
            {chosenRound !== undefined && (
              <p className="hint">
                Scores this round for <b>{chosenRound.competitions.join(' and ')}</b>
                {chosenRound.holes !== null ? `, over ${chosenRound.holes} holes` : ''}.
              </p>
            )}
          </div>
        ) : (
          <p className="check" style={{ color: '#8a6d00' }}>
            Every round in your rules already exists for this event. Add another round id on the{' '}
            <Link href="/rulesets">Rules</Link> page, or delete an existing round.
          </p>
        )}

        <div className="field">
          <label htmlFor="name">Call it</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Thursday morning" />
        </div>
        <div className="field">
          <label htmlFor="date">Date (optional)</label>
          <input id="date" type="date" value={playedOn} onChange={(e) => setPlayedOn(e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">2 · Where, and off which tee</h2>
        <div className="field">
          <label htmlFor="course">Course</label>
          <select id="course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name} ({course.totalHoles} holes)
              </option>
            ))}
          </select>
        </div>

        {teeSets.length > 1 && (
          <div className="field">
            <label htmlFor="tee">Tee</label>
            <select id="tee" value={teeSetId} onChange={(e) => setTeeSetId(e.target.value)}>
              {teeSets.map((tee) => (
                <option key={tee.id} value={tee.id}>
                  {tee.name}
                  {tee.gender === 'womens' ? ' (ladies)' : ''}
                  {tee.yardageTotal !== null ? ` — ${tee.yardageTotal} yds` : ''}
                  {tee.slopeRating !== null ? `, slope ${tee.slopeRating}` : ''}
                </option>
              ))}
            </select>
            <p className="hint">
              The tee decides the pars and stroke indexes this round is scored against.
            </p>
          </div>
        )}
        {teeSets.length === 1 && (
          <p className="hint">
            One tee set on this course: <b>{teeSets[0]?.name}</b>.
          </p>
        )}

        <div className="field">
          <label htmlFor="holes">Holes</label>
          <div className="seg">
            {HOLE_CHOICES.map((choice) => (
              <button
                key={choice.mode}
                type="button"
                aria-pressed={holeMode === choice.mode}
                onClick={() => setHoleMode(choice.mode)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <p className="hint">
            {holesInPlay} holes
            {chosenTee?.parTotal !== null && chosenTee !== undefined && holeMode === 'all'
              ? `, par ${chosenTee.parTotal}`
              : ''}
            . A short round is scaled against the target if your rules say to.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">3 · Tee times</h2>
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={makeSheet}
            onChange={(e) => setMakeSheet(e.target.checked)}
            style={{ width: 'auto', marginRight: '0.5rem' }}
          />
          Lay out a tee sheet now
        </label>
        {makeSheet && rosterSize === 0 && (
          <p className="check fail" style={{ marginTop: '0.6rem' }}>
            Nobody is on the roster, so there is nobody to group. The round will still be
            scheduled.
          </p>
        )}
        {makeSheet && rosterSize > 0 && (
          <>
            <div className="seg" style={{ marginTop: '0.75rem' }}>
              {(['balanced', 'similar', 'snake'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={strategy === option}
                  onClick={() => setStrategy(option)}
                >
                  {option[0]?.toUpperCase()}
                  {option.slice(1)}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <span style={{ flex: '1 1 auto' }}>
                <label htmlFor="size" className="meta">Players a group</label>
                <input id="size" value={groupSize} onChange={(e) => setGroupSize(e.target.value)} inputMode="numeric" />
              </span>
              <span style={{ flex: '1 1 auto' }}>
                <label htmlFor="first" className="meta">First tee time</label>
                <input id="first" value={firstTime} onChange={(e) => setFirstTime(e.target.value)} />
              </span>
              <span style={{ flex: '1 1 auto' }}>
                <label htmlFor="gap" className="meta">Minutes apart</label>
                <input id="gap" value={interval} onChange={(e) => setIntervalMinutes(e.target.value)} inputMode="numeric" />
              </span>
            </div>
            <p className="hint">
              {groupCount} {groupCount === 1 ? 'group' : 'groups'} from {firstTime}. You can move
              anyone afterwards, and nothing is fixed until you lock it.
            </p>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">4 · Check it over</h2>
        <dl className="outcome" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <dt>Event</dt>
          <dd style={{ textAlign: 'left' }}>{events.find((e) => e.id === eventId)?.name}</dd>
          <dt>Round</dt>
          <dd style={{ textAlign: 'left' }}>
            {roundKey || '—'}
            {chosenRound !== undefined ? ` · ${chosenRound.competitions.join(' and ')}` : ''}
          </dd>
          <dt>Course</dt>
          <dd style={{ textAlign: 'left' }}>
            {chosenCourse?.name}
            {chosenTee !== undefined ? ` · ${chosenTee.name} tees` : ''}
          </dd>
          <dt>Holes</dt>
          <dd style={{ textAlign: 'left' }}>
            {holesInPlay} ({HOLE_CHOICES.find((choice) => choice.mode === holeMode)?.label})
          </dd>
          <dt>Tee sheet</dt>
          <dd style={{ textAlign: 'left' }}>
            {makeSheet && rosterSize > 0
              ? `${groupCount} groups from ${firstTime}, ${interval} minutes apart`
              : 'none for now'}
          </dd>
        </dl>

        {error !== '' && <p className="error" style={{ marginTop: '0.9rem' }}>{error}</p>}
        <button
          type="button"
          onClick={() => void schedule()}
          disabled={busy || rulesetRounds.length === 0}
          style={{ marginTop: '0.9rem' }}
        >
          {busy ? 'Scheduling…' : 'Schedule this round'}
        </button>
        <p className="note">
          <Link href="/rounds">Rounds</Link>
          {' · '}
          <Link href="/tee-times">Tee times</Link>
        </p>
      </div>
    </>
  );
}

export default function ScheduleRoundPage() {
  return (
    <Suspense fallback={<div className="card">Loading…</div>}>
      <ScheduleRound />
    </Suspense>
  );
}
