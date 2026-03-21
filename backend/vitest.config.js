import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.test.js'],
    environment: 'node',
    coverage: {
      reportsDirectory: '../_out/coverage',
    },
  },
});
