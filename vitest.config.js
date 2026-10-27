import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Only the DOM-free logic is unit tested; render.js and main.js need a browser.
      include: ['src/js/diff.js', 'src/js/stats.js', 'src/js/utils.js'],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
    },
  },
});
