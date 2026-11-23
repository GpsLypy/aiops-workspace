import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { id, now, httpError, publicUser } from './store.mjs';
import { gatewayIdentity, production } from './security.mjs';

const credentials = z.object({ username: z.string().trim().regex(/^[a-zA-Z0-9_.-]{3,40}$/), password: z.string().min(12).max(200), name: z.string().trim().min(1).max(60).optional() });
export function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function verify(password, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
const digest = token => createHash('sha256').update(token).digest('hex');
const dummyPassword = hashPassword('constant-time-dummy-password');
export function createUser(store, input, role = 'member') {
  const data = credentials.parse(input);
  if (store.get('SELECT id FROM users WHERE username=?', data.username)) throw httpError(409, '用户名已存在');
  const user = { id: id(), username: data.username, name: data.name || data.username, role, active: 1 };
  store.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)', user.id, user.username, user.name, hashPassword(data.password), role, 1, now());
  return publicUser(user);
}
export function authRoutes(app, store) {
  const attempts = new Map();
  const secure = process.env.COOKIE_SECURE === 'true';
  const cookie = token => `aiops_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 604800 : 0}${secure ? '; Secure' : ''}`;
  const establish = (res, user) => {
    store.run('DELETE FROM auth_sessions WHERE expires<?', Date.now());
    const token = randomBytes(32).toString('hex');
    store.run('INSERT INTO auth_sessions VALUES(?,?,?)', digest(token), user.id, Date.now() + 7 * 86400000);
    res.setHeader('Set-Cookie', cookie(token));
    return publicUser(user);
  };
  app.get('/api/auth/status', (req, res) => res.json({ initialized: !!store.get('SELECT id FROM users LIMIT 1'), authMode: process.env.AUTH_MODE || 'local', setupTokenRequired: !!process.env.SETUP_TOKEN || production() }));
  app.post('/api/auth/setup', (req, res) => {
    if (!store.get('SELECT id FROM users LIMIT 1') && (production() || process.env.SETUP_TOKEN)) {
      const supplied = Buffer.from(String(req.body.setupToken || '')); const expected = Buffer.from(process.env.SETUP_TOKEN || '');
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpError(403, '需要有效的一次性初始化凭证');
    }
    const user = store.transaction(() => {
      if (store.get('SELECT id FROM users LIMIT 1')) throw httpError(409, '系统已初始化，请登录');
      return createUser(store, req.body, 'admin');
    });
    store.audit(user, 'auth.setup', user.id);
    res.status(201).json(establish(res, user));
  });
  app.post('/api/auth/login', (req, res) => {
    if (process.env.AUTH_MODE === 'gateway') throw httpError(403, '请通过企业身份网关登录');
    const key = req.ip;
    const time = Date.now();
    if (attempts.size > 1000) for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    if (attempts.size > 1000 && !attempts.has(key)) throw httpError(429, '登录服务繁忙');
    const attempt = attempts.get(key) || { count: 0, until: time + 60000 };
    if (attempt.until < time) { attempt.count = 0; attempt.until = time + 60000; }
    if (++attempt.count > 10) throw httpError(429, '登录尝试过于频繁，请一分钟后重试');
    attempts.set(key, attempt);
    const input = z.object({ username: z.string().max(100), password: z.string().max(200) }).parse(req.body);
    const user = store.get('SELECT * FROM users WHERE username=?', input.username);
    const valid = verify(input.password, user?.password || dummyPassword);
    if (!valid || !user?.active) { store.audit(null, 'auth.failed', '', { ip: req.ip }); throw httpError(401, '用户名或密码错误'); }
    attempts.delete(key);
    store.audit(user, 'auth.login', user.id);
    res.json(establish(res, user));
  });
  app.use('/api', (req, res, next) => {
    if (process.env.AUTH_MODE === 'gateway') {
      const claims = gatewayIdentity(req);
      const user = store.get('SELECT * FROM users WHERE username=? AND active=1', claims.username);
      if (!user) return res.status(403).json({ error: '企业账号尚未授权或已停用' });
      req.user = publicUser(user); req.authToken = ''; return next();
    }
    const token = /(?:^|;\s*)aiops_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const user = token && store.get('SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>? AND u.active=1', digest(token), Date.now());
    if (!user) return res.status(401).json({ error: '请先登录' });
    req.user = publicUser(user);
    req.authToken = digest(token);
    next();
  });
  app.get('/api/auth/me', (req, res) => res.json(req.user));
  app.post('/api/auth/logout', (req, res) => { store.run('DELETE FROM auth_sessions WHERE token=?', req.authToken); res.setHeader('Set-Cookie', cookie('')); res.json({ ok: true }); });
  app.post('/api/auth/password', (req, res) => {
    if (process.env.AUTH_MODE === 'gateway') throw httpError(403, '请在企业身份系统修改密码');
    const input = z.object({ currentPassword: z.string().max(200), password: z.string().min(12).max(200) }).parse(req.body);
    const user = store.get('SELECT * FROM users WHERE id=?', req.user.id);
    if (!verify(input.currentPassword, user.password)) throw httpError(400, '原密码不正确');
    store.transaction(() => { store.run('UPDATE users SET password=? WHERE id=?', hashPassword(input.password), user.id); store.run('DELETE FROM auth_sessions WHERE user_id=?', user.id); });
    store.audit(req.user, 'auth.password', user.id);
    res.json(establish(res, user));
  });
}
export function admin(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' }); next(); }
