'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { authClient } from '../../lib/auth-client';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (token === '') {
    return (
      <div className="card">
        <p className="error">This reset link is missing its token.</p>
        <p className="note">
          Links expire after an hour and work only once.{' '}
          <Link href="/forgot-password">Request a new one</Link>.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card">
        <p className="ok">Your password has been changed.</p>
        <p className="note">
          <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: failure } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (failure) {
      setError(
        failure.message ??
          'That link is no longer valid. Reset links expire after an hour and work only once.',
      );
      return;
    }
    setDone(true);
  }

  return (
    <form className="card" onSubmit={submit}>
      {error !== '' && <p className="error">{error}</p>}
      <div className="field">
        <label htmlFor="password">New password</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
        <p className="hint">At least 10 characters.</p>
      </div>
      <div className="field">
        <label htmlFor="confirm">Confirm new password</label>
        <input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={10} autoComplete="new-password" />
      </div>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Set new password'}</button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <h1>Set a new password</h1>
      <p className="sub">Divot Diggers</p>
      <Suspense fallback={<div className="card">Loading…</div>}>
        <ResetForm />
      </Suspense>
    </>
  );
}
