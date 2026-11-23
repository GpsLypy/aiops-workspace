import { request } from 'node:http';

export function brokerRequest({ socketPath, token }, method, path, value) {
  if (path !== '/v1/health' && !/^\/v1\/jobs(?:\/[-a-f0-9]{36})?(?:\/(?:cancel|artifacts\/[-a-f0-9]{36}\/(?:decision|download|preview)))?$/.test(path)
    && !/^\/v1\/jobs\/by-step\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(path)) throw new Error('Invalid broker client route');
  return new Promise((resolve, reject) => {
    const payload = value === undefined ? null : JSON.stringify(value);
    const req = request({ socketPath, method, path, headers: { Authorization: `Bearer ${token}`,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      const parts = []; let bytes = 0;
      res.on('data', part => { bytes += part.length; if (bytes > 2097152) res.destroy(new Error('Broker response quota')); else parts.push(part); });
      res.on('error', reject);
      res.on('end', () => {
        const buffer = Buffer.concat(parts);
        if (res.statusCode !== 200) { const error = new Error(`Broker returned HTTP ${res.statusCode}`); error.status = res.statusCode; reject(error); return; }
        if (res.headers['content-type'] === 'application/octet-stream' || res.headers['content-type']?.startsWith('text/plain')) { resolve(buffer); return; }
        try { resolve(JSON.parse(buffer.toString('utf8'))); } catch { reject(new Error('Invalid broker JSON')); }
      });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Broker timeout')));
    req.end(payload);
  });
}
