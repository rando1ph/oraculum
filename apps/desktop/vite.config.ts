import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    // Keep every asset in the manifest rather than opening data: in the CSP.
    assetsInlineLimit: 0,
    target: 'es2022',
    modulePreload: { polyfill: false },
  },
});
