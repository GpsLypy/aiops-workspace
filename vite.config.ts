import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Serve the reviewed, standalone viewer in development and include the same
// bytes in dist. This keeps its relative URL independent of the SPA fallback.
const diagramFiles: Record<string, string> = {
  '/architecture.html': './docs/web/architecture-viewer.html',
  '/diagrams/system.html': './docs/site/architecture.html',
  '/diagrams/request-flow.html': './docs/site/request-flow.html',
};
const diagram = (path: string) => readFileSync(new URL(diagramFiles[path], import.meta.url));
export default defineConfig({ plugins: [react(), {
  name: 'architecture-viewer',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split('?')[0] || '';
      if (!Object.hasOwn(diagramFiles, path)) return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(diagram(path));
    });
  },
  generateBundle() {
    for (const path of Object.keys(diagramFiles)) this.emitFile({ type: 'asset', fileName: path.slice(1), source: diagram(path) });
  },
}], server: { proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } } } });
