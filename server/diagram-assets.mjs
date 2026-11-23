import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Only these reviewed public assets can embed each other. The application and
// every other response keep the normal DENY / production CSP defaults.
export function diagramAssetHeaders(dist) {
  const entry = resolve(dist, 'architecture.html');
  const files = new Set([entry, resolve(dist, 'diagrams/system.html'), resolve(dist, 'diagrams/request-flow.html')]);
  return (res, filename) => {
    if (!files.has(filename)) return;
    const html = readFileSync(filename, 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
    res.setHeader('X-Frame-Options', filename === entry ? 'DENY' : 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'", `script-src 'self' ${scripts.join(' ')}`,
      "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
      "frame-src 'self'", `frame-ancestors ${filename === entry ? "'none'" : "'self'"}`,
      "connect-src 'none'", "worker-src 'self' blob:", "base-uri 'none'", "form-action 'none'",
    ].join('; '));
  };
}
