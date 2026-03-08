import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      reportsDirectory: '../_out/coverage',
    },
  },
});
