'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface RulesetSummary {
  id: string;
  key: string;
  name: string;
  version: number;
  isSystemPreset: boolean;
}

export default function RulesetsPage() {
  const [rulesets, setRulesets] = useState<RulesetSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');

  const load = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/rulesets`, { credentials: 'include' });
    if (response.status === 401) {
      setState('signed-out');
      return;
    }
    setRulesets(((await response.json()) as { rulesets: RulesetSummary[] }).rulesets);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  // Only the newest version of each key is worth offering to edit.
  const newest = new Map<string, RulesetSummary>();
  for (const ruleset of rulesets) {
    const existing = newest.get(ruleset.key);
    if (existing === undefined || ruleset.version > existing.version) {
      newest.set(ruleset.key, ruleset);
    }
  }

  return (
    <>
      <h1>Rules</h1>
      <p className="sub">How your competitions are scored.</p>

      <div className="card">
        {newest.size === 0 ? (
          <p className="hint">Nothing yet. Start a set of rules and edit it to suit your group.</p>
        ) : (
          <ul className="list">
            {[...newest.values()].map((ruleset) => (
              <li key={ruleset.id}>
                <span>
                  {ruleset.name}
                  <br />
                  <span className="meta">
                    version {ruleset.version}
                    {ruleset.isSystemPreset ? ' · shared preset' : ''}
                  </span>
                </span>
                <Link href={`/rulesets/edit?from=${ruleset.id}`}>
                  <button type="button">Edit</button>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="note">
          <Link href="/rulesets/edit">Start from scratch</Link>
          {' · '}
          <Link href="/roster">Roster</Link>
          {' · '}
          <Link href="/standings">Standings</Link>
          {' · '}
          <Link href="/dashboard">Account</Link>
        </p>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <p className="hint">
          Editing publishes a new version. Events already under way keep scoring by the version
          they started on, so changing a point value now can never rewrite a past result.
        </p>
      </div>
    </>
  );
}
