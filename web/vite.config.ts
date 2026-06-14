import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built for claude-cockpit's Node server, which serves this from web/dist.
// base: './' keeps asset URLs relative so it loads behind `tailscale serve`
// or any sub-path. Everything is bundled — no runtime CDN calls.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
