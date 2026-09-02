import Link from 'next/link';

export default function VerifiedPage() {
  return (
    <>
      <h1>Email confirmed</h1>
      <p className="sub">Your account is ready.</p>
      <div className="card">
        <p className="ok">Thanks — your email address is confirmed.</p>
        <p className="note">
          <Link href="/dashboard">Go to your account</Link>
        </p>
      </div>
    </>
  );
}
