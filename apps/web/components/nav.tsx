'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiUrl, authClient } from '../lib/auth-client';

/**
 * The planner's way around.
 *
 * Ordered the way a season is built rather than alphabetically: people first, then where they
 * play, then when, then what happened. Hidden on the signed-out pages, where there is nowhere
 * to go but in.
 */
const LINKS = [
  { href: '/roster', label: 'Roster' },
  { href: '/courses', label: 'Courses' },
  { href: '/tee-times', label: 'Tee times' },
  { href: '/standings', label: 'Standings' },
  { href: '/rulesets', label: 'Rules' },
];

const SIGNED_OUT = ['/sign-in', '/sign-up', '/forgot-password', '/reset-password', '/verified'];

export function Nav() {
  const pathname = usePathname();
  const [me, setMe] = useState<{ displayName: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${apiUrl}/api/me`, { credentials: 'include' });
      if (cancelled || !response.ok) return;
      setMe((await response.json()) as { displayName: string });
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (SIGNED_OUT.includes(pathname) || pathname === '/') return null;

  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href="/roster" className="brand">
          Divot Diggers
        </Link>
        <ul>
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={pathname.startsWith(link.href) ? 'page' : undefined}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="nav-end">
          {me !== null && (
            <>
              <Link href="/dashboard" className="who">
                {me.displayName}
              </Link>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  void authClient.signOut().then(() => {
                    window.location.href = '/sign-in';
                  })
                }
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
