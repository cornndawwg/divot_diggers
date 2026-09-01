import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      '{apps,packages}/*/src/**/*.{test,spec}.ts',
      '{apps,packages}/*/tests/**/*.{test,spec}.ts',
    ],
    // Phase 1.1 ships the scaffold with no tests yet. Task 1.2 onward adds them.
    passWithNoTests: true,
  },
});
