import type { ReactNode } from 'react';
import { Nav } from '../components/nav';
import './globals.css';

export const metadata = {
  title: 'Divot Diggers',
  description: 'Group console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
