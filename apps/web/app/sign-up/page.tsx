'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '../../lib/auth-client';

export default function SignUpPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const { error: failure } = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (failure) {
      setError(failure.message ?? 'Could not create the account.');
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <>
        <h1>Check your email</h1>
        <p className="sub">One more step.</p>
        <div className="card">
          <p className="ok">We sent a confirmation link to {email}.</p>
          <p className="note">
            Open it to finish setting up your account. You cannot sign in until the address is
            confirmed. Nothing arrived? Check the spam folder.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Create your account</h1>
      <p className="sub">Divot Diggers</p>
      <form className="card" onSubmit={submit}>
        {error !== '' && <p className="error">{error}</p>}
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
          <p className="hint">At least 10 characters.</p>
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        <p className="note">
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </form>
    </>
  );
}
