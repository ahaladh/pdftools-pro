import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from './csp';

// One variable drives the public origin everywhere: sitemap/robots (scripts/seo.mjs), canonical/OG URLs in the app, and prerendering.
process.env.VITE_SITE_URL ??= process.env.SITE_URL;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: false } } },
  // `vite preview` serves the production build with the real security headers (used by the e2e suite).
  preview: { port: 4173, strictPort: true, headers: SECURITY_HEADERS, proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: false } } },
  build: { sourcemap: false, rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], pdfjs: ['pdfjs-dist'] } } } },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], globals: true },
});
