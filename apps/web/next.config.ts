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
  env: {
    NEXT_PUBLIC_API_URL: process.env['API_URL'] ?? 'http://localhost:8787',
  },
};

export default config;
