import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.TEAMBOT_DEV_SERVER || 'http://127.0.0.1:4747';

export default defineConfig({
  root: 'ui',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Mermaid's optional ELK layout (elkjs: EPL-2.0 OR GPL-3.0) is not shipped; see ui/src/lib/elk-stub.ts.
    alias: [{ find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: fileURLToPath(new URL('./ui/src/lib/elk-stub.ts', import.meta.url)) }],
  },
  // Fonts are never inlined as data: URLs: the page's CSP (server/app.ts) only loads fonts from the app itself (KaTeX).
  build: { outDir: '../dist/ui', emptyOutDir: true, chunkSizeWarningLimit: 2000, assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined) },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
});
