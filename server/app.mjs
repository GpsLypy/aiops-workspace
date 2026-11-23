import express from 'express';
import { diagramAssetHeaders } from './diagram-assets.mjs';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { openStore } from './store.mjs';
import { authRoutes, createUser } from './auth.mjs';
import { resourceRoutes } from './resources.mjs';
import { modelRoutes } from './model.mjs';
import { mcpRoutes } from './mcp.mjs';
import { createEngine, agentRoutes } from './agent.mjs';
import { createScheduler, taskRoutes } from './scheduler.mjs';
import { validateEnvironment, production } from './security.mjs';
import { createExecutionService, executionRoutes } from './execution.mjs';
import { requestLogging, createOperations, operationsRoutes } from './operations.mjs';
import { indexKnowledge } from './governance.mjs';
import { createNotifications, notificationRoutes } from './notifications.mjs';
import { runbookRoutes } from './runbooks.mjs';
import { runtimeOptions } from './agent-runtime/index.mjs';
import { rolloutRoutes } from './agent-rollout.mjs';
import { localServicesRoutes } from './local-services.mjs';
import { documentRoutes } from './documents.mjs';

export function createApplication(options = {}) {
  validateEnvironment();
  const agentRuntime = runtimeOptions(options.agentRuntime);
  const store = openStore(options.dataDir);
  for (const row of store.all("SELECT * FROM resources WHERE kind='knowledge' AND id NOT IN (SELECT resource_id FROM knowledge_search)")) indexKnowledge(store, store.resource(row));
  if (!store.get('SELECT id FROM users LIMIT 1') && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) createUser(store, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }, 'admin');
  const app = express();
  app.disable('x-powered-by');
  requestLogging(app);
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(s => s.trim()));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    if (production()) res.set({ 'Strict-Transport-Security': 'max-age=31536000', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
      if (origin && origin !== expected) return res.status(403).json({ error: '请求来源不匹配' });
      if (!req.is('application/json')) return res.status(415).json({ error: '请求必须使用 application/json' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb', verify: (req, res, buffer) => { req.rawBody = buffer; } }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  authRoutes(app, store);
  resourceRoutes(app, store);
  modelRoutes(app, store, options.modelSettings);
  const execution = createExecutionService(store);
  mcpRoutes(app, store, execution);
  executionRoutes(app, store, execution);
  runbookRoutes(app, store, execution);
  const engine = createEngine(store, execution, { ...agentRuntime, telemetry: options.agentTelemetry });
  rolloutRoutes(app, engine);
  const scheduler = createScheduler(store, engine);
  const notifications = createNotifications(store);
  const operations = createOperations(store, execution, scheduler, notifications, engine);
  notificationRoutes(app, store);
  operationsRoutes(app, store, execution, operations);
  localServicesRoutes(app, options.localServices);
  documentRoutes(app, store, options.documents);
  agentRoutes(app, store, engine);
  taskRoutes(app, store, scheduler);
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { setHeaders: diagramAssetHeaders(dist) }));
    app.get('/{*path}', (req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大（最多 1 MB）' });
    if (error instanceof SyntaxError || error instanceof RangeError) return res.status(400).json({ error: '请求数据格式无效' });
    if (!error.status) console.error('API error:', error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : '服务器内部错误', ...(error.conversationId ? { conversationId: error.conversationId } : {}), ...(error.runId ? { runId: error.runId } : {}) });
  });
  if (options.scheduler !== false) scheduler.start();
  if (options.scheduler !== false) operations.start();
  return { app, store, engine, scheduler, execution, operations, notifications, close: async () => { engine.stop(); execution.stop(); await operations.close(); await notifications.close(); await scheduler.stop(); await execution.idle(); await engine.close(); store.close(); } };
}
