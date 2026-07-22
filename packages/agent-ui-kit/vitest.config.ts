import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    // RTL's auto-cleanup registers itself on the global afterEach hook.
    globals: true,
    include: ['src/**/*.vitest.{ts,tsx}'],
  },
});
