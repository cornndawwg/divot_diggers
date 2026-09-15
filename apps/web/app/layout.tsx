import type { ReactNode } from 'react';
import { Nav } from '../components/nav';
import { EventBar } from '../components/event-bar';
import { CurrentEventProvider } from '../lib/current-event';
import './globals.css';

export const metadata = {
  title: 'Divot Diggers',
  description: 'Group console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CurrentEventProvider>
          <Nav />
          <EventBar />
          <main>{children}</main>
        </CurrentEventProvider>
      </body>
    </html>
  );
}
