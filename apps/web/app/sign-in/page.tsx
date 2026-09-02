'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '../../lib/auth-client';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setUnverified(false);
    setBusy(true);
    const { error: failure } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (failure) {
      // 403 is specifically "the address has not been confirmed", which needs different
      // advice from a wrong password.
      if (failure.status === 403) {
        setUnverified(true);
        return;
      }
      setError('That email and password do not match an account.');
      return;
    }
    router.push('/dashboard');
  }

  return (
    <>
      <h1>Sign in</h1>
      <p className="sub">Divot Diggers</p>
      <form className="card" onSubmit={submit}>
        {error !== '' && <p className="error">{error}</p>}
        {unverified && (
          <p className="error">
            This address has not been confirmed yet. Open the link in the email we sent you.
          </p>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="note">
          <Link href="/forgot-password">Forgot your password?</Link>
          <br />
          No account yet? <Link href="/sign-up">Create one</Link>
        </p>
      </form>
    </>
  );
}
