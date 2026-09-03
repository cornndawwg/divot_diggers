import type { NextConfig } from 'next';

const config: NextConfig = {
  // Next 16 writes its own CLAUDE.md and AGENTS.md into this directory on boot. The
  // repository already has a CLAUDE.md at the root that is the working agreement, and a
  // second one further down the tree competing with it is worse than none.
  agentRules: false,

  // Workspace packages ship TypeScript source, so Next has to compile them. The scoring
  // engine runs in the browser for the ruleset preview — it is pure, with zero runtime
  // dependencies, which is exactly what makes that safe.
  transpilePackages: ['@ddga/types', '@ddga/scoring-engine'],

  // The console is a browser client of the API; it holds no database credentials.
  //
  // Requests go to /api/* on this origin and are proxied to the API server side. One origin
  // means: only one port to forward, no CORS, first-party session cookies, and an emailed
  // link that resolves from any device that can reach the console. It also matches how this
  // deploys — a single public host in front of both.
  env: {
    NEXT_PUBLIC_API_URL: '',
    // Only used while server-rendering, where there is no window to read an origin from.
    NEXT_PUBLIC_SITE_URL: process.env['PUBLIC_URL'] ?? 'http://localhost:3000',
  },

  async rewrites() {
    const api = process.env['API_INTERNAL_URL'] ?? 'http://localhost:8787';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default config;
