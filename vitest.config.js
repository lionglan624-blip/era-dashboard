import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'backend/vitest.config.js',
      'frontend/vite.config.js',
    ],
    coverage: {
      reportsDirectory: '_out/coverage',
    },
  },
});
