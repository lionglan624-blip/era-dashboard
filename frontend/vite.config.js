import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
  },
  server: {
    port: parseInt(process.env.VITE_PORT || '5173'),
    proxy: {
      '/api': `http://localhost:${process.env.VITE_BACKEND_PORT || '3001'}`,
      '/ws': {
        target: `ws://localhost:${process.env.VITE_BACKEND_PORT || '3001'}`,
        ws: true,
      },
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/', '*.config.js', 'dev-with-log.js'],
    },
  },
});
