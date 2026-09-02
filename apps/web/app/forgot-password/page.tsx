'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '../../lib/auth-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    // Always the same message, whether or not the address is registered: the page must
    // not reveal who has an account.
    setSent(true);
  }

  if (sent) {
    return (
      <>
        <h1>Check your email</h1>
        <p className="sub">Password reset</p>
        <div className="card">
          <p className="ok">If {email} has an account, a reset link is on its way.</p>
          <p className="note">
            The link expires in one hour and can only be used once.
            <br />
            <Link href="/sign-in">Back to sign in</Link>
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Forgot your password?</h1>
      <p className="sub">We will email you a link to set a new one.</p>
      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
        <p className="note">
          <Link href="/sign-in">Back to sign in</Link>
        </p>
      </form>
    </>
  );
}
