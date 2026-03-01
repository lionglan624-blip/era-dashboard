/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'vitest',
  vitest: {
    configFile: undefined, // uses default vitest config
  },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/**/*.js',
    '!src/**/*.test.js',
  ],
  timeoutMS: 60000,
  timeoutFactor: 2.5,
  concurrency: 4,
  thresholds: {
    high: 80,
    low: 60,
    break: null
  }
};
