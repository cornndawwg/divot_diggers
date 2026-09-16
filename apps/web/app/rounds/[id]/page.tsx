'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiUrl } from '../../../lib/auth-client';

interface RoundDetail {
  id: string;
  name: string;
  key: string;
  status: string;
  course: string | null;
  courseId: string | null;
  teeSet: string | null;
  playedOn: string | null;
  isPractice: boolean;
  holeSelection: { mode: string };
  resolved: { holeCount: number; parTotal: number } | null;
}

interface Course {
  id: string;
  name: string;
  teeSets: { id: string; name: string }[];
}

const SELECTIONS = [
  { mode: 'all', label: 'All 18' },
  { mode: 'front9', label: 'Front nine' },
  { mode: 'back9', label: 'Back nine' },
];

/**
 * Correcting a round after it exists.
 *
 * A round used to be write-once: a typo in the name, the wrong course chosen from a dropdown,
 * a date a day out — all permanent. What can be changed narrows once somebody has been
 * scored, because pars and stroke indexes are what turn strokes into points, and this page
 * says which is which rather than letting a save fail.
 */
export default function EditRoundPage() {
  const id = String(useParams()['id'] ?? '');
  const router = useRouter();
  const [round, setRound] = useState<RoundDetail | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [scored, setScored] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  const [name, setName] = useState('');
  const [playedOn, setPlayedOn] = useState('');
  const [courseId, setCourseId] = useState('');
  const [teeSetId, setTeeSetId] = useState('');
  const [selection, setSelection] = useState('all');
  const [isPractice, setIsPractice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/rounds/${id}`, { credentials: 'include' });
    if (!response.ok) {
      setState('missing');
      return;
    }
    const detail = (await response.json()) as RoundDetail;
    setRound(detail);
    setName(detail.name);
    setPlayedOn(detail.playedOn ?? '');
    setCourseId(detail.courseId ?? '');
    setSelection(detail.holeSelection.mode);
    setIsPractice(detail.isPractice);

    const courseResponse = await fetch(`${apiUrl}/api/courses`, { credentials: 'include' });
    if (courseResponse.ok) {
      setCourses(((await courseResponse.json()) as { courses: Course[] }).courses);
    }

    setState('ready');
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setProblem('');
    setSaved(false);
    const body: Record<string, unknown> = { name: name.trim() };
    body['playedOn'] = playedOn === '' ? null : playedOn;
    if (round !== null) {
      if (courseId !== '' && courseId !== round.courseId) body['courseId'] = courseId;
      if (teeSetId !== '') body['teeSetId'] = teeSetId;
      if (selection !== round.holeSelection.mode) body['holeSelection'] = { mode: selection };
      if (isPractice !== round.isPractice) body['isPractice'] = isPractice;
    }

    const response = await fetch(`${apiUrl}/api/rounds/${id}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const failure = (await response.json()) as { error?: string };
      setProblem(failure.error ?? 'Could not save that.');
      if (response.status === 409) setScored(1);
      return;
    }
    setSaved(true);
    await load();
  }

  if (state === 'loading') return <main className="page"><p>Loading…</p></main>;
  if (state === 'missing' || round === null) {
    return (
      <main className="page">
        <h1>Not found</h1>
        <p><Link href="/rounds">Back to rounds</Link></p>
      </main>
    );
  }

  const chosenCourse = courses.find((course) => course.id === courseId);

  return (
    <main className="page">
      <p className="meta"><Link href="/rounds">Rounds</Link></p>
      <h1>{round.name}</h1>
      <p className="hint">
        {round.resolved === null
          ? 'No holes resolved yet.'
          : `${round.resolved.holeCount} holes · par ${round.resolved.parTotal}`}
        {round.isPractice ? ' · practice, does not count' : ''}
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="date">Day played</label>
          <input id="date" type="date" value={playedOn} onChange={(e) => setPlayedOn(e.target.value)} />
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          The name and the day can always be corrected, whatever has been scored.
        </p>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">Where and what it counts for</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          These decide how strokes become points, so they can only change while nobody has
          been scored in this round.
        </p>
        <div className="field">
          <label htmlFor="course">Course</label>
          <select id="course" value={courseId} onChange={(e) => { setCourseId(e.target.value); setTeeSetId(''); }}>
            <option value="">No course</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>{course.name}</option>
            ))}
          </select>
        </div>
        {chosenCourse !== undefined && chosenCourse.teeSets.length > 0 && (
          <div className="field">
            <label htmlFor="tee">Tee set</label>
            <select id="tee" value={teeSetId} onChange={(e) => setTeeSetId(e.target.value)}>
              <option value="">{round.teeSet ?? 'Longest'}</option>
              {chosenCourse.teeSets.map((tee) => (
                <option key={tee.id} value={tee.id}>{tee.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="holes">Holes</label>
          <select id="holes" value={selection} onChange={(e) => setSelection(e.target.value)}>
            {SELECTIONS.map((option) => (
              <option key={option.mode} value={option.mode}>{option.label}</option>
            ))}
          </select>
        </div>
        <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
          <input type="checkbox" checked={isPractice} onChange={(e) => setIsPractice(e.target.checked)} />
          <span>Practice round — does not count towards anything</span>
        </label>
      </div>

      {problem !== '' && <p className="check fail" style={{ marginTop: '1rem' }}>{problem}</p>}
      {saved && <p className="ok" style={{ marginTop: '1rem' }}>Saved.</p>}
      {scored > 0 && (
        <p className="hint">
          You can still correct the name and the day above, then save again.
        </p>
      )}

      <div className="row" style={{ marginTop: '1rem' }}>
        <button type="button" className="ghost" onClick={() => router.push('/rounds')}>Back</button>
        <button type="button" onClick={() => void save()} disabled={busy || name.trim() === ''}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </main>
  );
}
