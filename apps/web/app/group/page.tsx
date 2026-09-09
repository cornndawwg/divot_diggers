'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '../../lib/auth-client';

interface Member {
  personId: string;
  displayName: string;
  email: string | null;
  role: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

/**
 * What each role is called, and what holding it actually lets somebody do.
 *
 * Authority belongs to the group, not to one event: a Group Owner or Group Admin runs every
 * event the group has ever held, including ones set up before they arrived.
 */
const ROLES = [
  {
    key: 'owner',
    label: 'Group Owner',
    hint: 'Runs the group. Can do everything an admin can, and can appoint or replace owners.',
  },
  {
    key: 'admin',
    label: 'Group Admin',
    hint: 'Sets up events, the roster, courses and rules. Cannot change who the owners are.',
  },
  {
    key: 'member',
    label: 'Member',
    hint: 'Plays. Sees the roster, the tee sheet and the standings, and changes none of them.',
  },
] as const;

const labelFor = (role: string): string =>
  ROLES.find((entry) => entry.key === role)?.label ?? role;

export default function GroupPage() {
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [orgId, setOrgId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [me, setMe] = useState<string>('');
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'none'>('loading');

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const loadMembers = useCallback(async (org: string) => {
    const response = await fetch(`${apiUrl}/api/organizations/${org}/members`, {
      credentials: 'include',
    });
    if (!response.ok) return;
    const body = (await response.json()) as { members: Member[]; invitations: Invitation[] };
    setMembers(body.members);
    setInvitations(body.invitations);
  }, []);

  const load = useCallback(async () => {
    const meResponse = await fetch(`${apiUrl}/api/me`, { credentials: 'include' });
    if (meResponse.status === 401) {
      setState('signed-out');
      return;
    }
    setMe(((await meResponse.json()) as { id: string }).id);

    const response = await fetch(`${apiUrl}/api/organizations`, { credentials: 'include' });
    const loaded = response.ok
      ? ((await response.json()) as { organizations: { id: string; name: string }[] })
          .organizations
      : [];
    setOrgs(loaded);
    if (loaded.length === 0) {
      setState('none');
      return;
    }
    const active = loaded[0]?.id ?? '';
    setOrgId(active);
    await loadMembers(active);
    setState('ready');
  }, [loadMembers]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    setBusy(true);
    setMessage('');
    setProblem('');
    const response = await fetch(`${apiUrl}/api/organizations/${orgId}/invitations`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), role }),
    });
    setBusy(false);
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setProblem(body.error ?? 'Could not send that invitation.');
      return;
    }
    setMessage(
      `Invited ${email.trim()} as ${labelFor(role)}. The link in their email lasts 14 days.`,
    );
    setEmail('');
    await loadMembers(orgId);
  }

  async function changeRole(personId: string, next: string) {
    setProblem('');
    setMessage('');
    const response = await fetch(
      `${apiUrl}/api/organizations/${orgId}/members/${personId}/role`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setProblem(body.error ?? 'Could not change that.');
    }
    await loadMembers(orgId);
  }

  async function revoke(id: string) {
    await fetch(`${apiUrl}/api/organizations/${orgId}/invitations/${id}/revoke`, {
      method: 'POST',
      credentials: 'include',
    });
    setMessage('Invitation withdrawn. That link no longer works.');
    await loadMembers(orgId);
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
        <h1>No group yet</h1>
        <div className="card">
          <p className="note">
            Set one up on the <Link href="/roster">Roster</Link> page.
          </p>
        </div>
      </>
    );
  }

  const myRole = members.find((member) => member.personId === me)?.role ?? 'member';
  const iAmOwner = myRole === 'owner';
  const iAdminister = iAmOwner || myRole === 'admin';
  const owners = members.filter((member) => member.role === 'owner').length;

  return (
    <>
      <h1>{orgs.find((org) => org.id === orgId)?.name ?? 'Group'}</h1>
      <p className="sub">
        {members.length} {members.length === 1 ? 'person' : 'people'} · you are{' '}
        {labelFor(myRole)}
      </p>

      {problem !== '' && <p className="check fail">{problem}</p>}
      {message !== '' && <p className="ok">{message}</p>}

      <div className="card">
        <h2 className="section">Who runs this group</h2>
        <ul className="list">
          {members.map((member) => (
            <li key={member.personId}>
              <span>
                {member.displayName}
                {member.personId === me ? ' (you)' : ''}
                <br />
                <span className="meta">{member.email ?? 'no email on file'}</span>
              </span>
              {iAdminister ? (
                <select
                  aria-label={`Role for ${member.displayName}`}
                  value={member.role}
                  onChange={(changed) => void changeRole(member.personId, changed.target.value)}
                  disabled={
                    // An admin may not touch an owner, and the last owner cannot step down.
                    (!iAmOwner && member.role === 'owner') ||
                    (member.role === 'owner' && owners <= 1)
                  }
                  style={{ maxWidth: '11rem' }}
                >
                  {ROLES.filter((entry) => iAmOwner || entry.key !== 'owner').map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="meta">{labelFor(member.role)}</span>
              )}
            </li>
          ))}
        </ul>
        {owners <= 1 && iAdminister && (
          <p className="hint">
            This group has one owner, so their role is fixed. Make somebody else an owner
            first if you want to hand it over.
          </p>
        )}
      </div>

      {iAdminister && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h2 className="section">Invite somebody</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            They get an email with a link. They do not need an account first — signing up is
            part of accepting.
          </p>
          <div className="row">
            <span style={{ flex: '2 1 14rem' }}>
              <label htmlFor="invite-email" className="meta">
                Email address
              </label>
              <input
                id="invite-email"
                value={email}
                onChange={(changed) => setEmail(changed.target.value)}
                placeholder="levi@example.com"
                inputMode="email"
              />
            </span>
            <span style={{ flex: '1 1 10rem' }}>
              <label htmlFor="invite-role" className="meta">
                Joining as
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(changed) => setRole(changed.target.value)}
              >
                {ROLES.filter((entry) => iAmOwner || entry.key !== 'owner').map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <p className="hint">{ROLES.find((entry) => entry.key === role)?.hint}</p>
          <button
            type="button"
            onClick={() => void invite()}
            disabled={busy || email.trim() === ''}
          >
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
          {!iAmOwner && (
            <p className="hint">
              Only a Group Owner can invite another owner.
            </p>
          )}
        </div>
      )}

      {iAdminister && invitations.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h2 className="section">Waiting to be accepted</h2>
          <ul className="list">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <span>
                  {invitation.email}
                  <br />
                  <span className="meta">
                    {labelFor(invitation.role)} · expires{' '}
                    {new Date(invitation.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <button type="button" className="ghost" onClick={() => void revoke(invitation.id)}>
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" style={{ marginTop: '1rem' }}>
        <h2 className="section">What the roles mean</h2>
        {ROLES.map((entry) => (
          <p key={entry.key} className="meta" style={{ marginBottom: '0.4rem' }}>
            <b>{entry.label}</b> — {entry.hint}
          </p>
        ))}
      </div>
    </>
  );
}
