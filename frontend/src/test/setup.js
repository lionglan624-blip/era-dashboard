import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Cleanup after each test (unmount React trees)
afterEach(() => {
  cleanup();
});

// Mock browser APIs not present in jsdom
global.ResizeObserver = class ResizeObserver {
  constructor(callback) {
    this._callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};

global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
