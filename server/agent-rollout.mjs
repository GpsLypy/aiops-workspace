import { createHash } from 'node:crypto';
import { z } from 'zod';
import { admin } from './auth.mjs';
import { httpError, now } from './store.mjs';
import { executableResource } from './governance.mjs';
import { createRuntimeDriver } from './agent-runtime/driver.mjs';

const key = 'agent:rollout';
const revisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
const draftSchema = z.object({
  agentIds: z.array(z.string().min(1).max(100)).max(200), includeGeneral: z.boolean(),
  contextMode: z.enum(['recent', 'budgeted']), retrievalMode: z.enum(['ranked', 'diverse']), evidenceReports: z.boolean(),
}).strict().refine(v => new Set(v.agentIds).size === v.agentIds.length, '子领域不能重复');
const baseline = { contextMode: 'recent', retrievalMode: 'ranked', evidenceReports: false };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createRollout(store, config, { makeDriver = createRuntimeDriver } = {}) {
  let checking = false, closed = false, probe, pending;
  const read = () => store.setting(key) || { version: 1, revision: 0, draftRevision: 0, mode: 'deployment', activeRevision: null,
    active: null, preflight: null, draft: { agentIds: [], includeGeneral: false, ...baseline } };
  const resources = () => store.all("SELECT * FROM resources WHERE kind='agents' ORDER BY created").map(store.resource);
  const eligible = r => r.status === '已启用' && executableResource(r);
  function authorize(user, revision) {
    if (closed) throw httpError(503, '运行时管理已关闭');
    const current = store.get('SELECT role,active FROM users WHERE id=?', user.id);
    if (!current?.active || current.role !== 'admin') throw httpError(403, '需要有效的管理员权限');
    const state = read();
    if (state.revision !== revision) throw httpError(409, '增强配置已被修改，请刷新后重试');
    return state;
  }
  function validate(draft) {
    if (!draft.agentIds.length && !draft.includeGeneral) throw httpError(422, '请选择至少一个子领域或通用 Agent');
    const entries = resources();
    return draft.agentIds.map(id => {
      const r = entries.find(r => r.id === id);
      if (!r || !eligible(r)) throw httpError(422, '增强作用域中的子领域必须已启用且已发布');
      return { id, revision: r.revision, updated: r.updated };
    });
  }
  const fingerprint = draft => hash({ config, draft, resources: validate(draft) });
  function commit(user, state, action, fields) {
    const next = { ...state, ...fields, revision: state.revision + 1, updatedAt: now(), updatedBy: user.id };
    store.setSetting(key, next);
    store.audit(user, `agent.rollout.${action}`, key, { revision: next.revision, draftRevision: next.draftRevision, activeRevision: next.activeRevision, mode: next.mode,
      ...(action === 'save' ? { draft: next.draft } : action === 'activate' ? { active: next.active } : {}) });
    return view();
  }
  function view() {
    const state = read();
    let preflightValid = false;
    if (state.preflight && Date.parse(state.preflight.expiresAt) > Date.now()) {
      try { preflightValid = state.preflight.draftRevision === state.draftRevision && state.preflight.fingerprint === fingerprint(state.draft); } catch { /* deployment/resources changed */ }
    }
    const { fingerprint: hidden, ...preflight } = state.preflight || {};
    return { ...state, preflight: state.preflight ? preflight : null, preflightValid, checking,
      deployment: { runtime: 'agentscope', workerMode: config.workerMode,
        contextMode: config.contextMode, contextMaxBytes: config.contextMaxBytes, retrievalMode: config.retrievalMode, evidenceReports: config.evidenceReports },
      agents: resources().map(r => ({ id: r.id, name: r.name, eligible: eligible(r) })),
      runtimeRequired: required() };
  }
  const required = () => true;
  function snapshot(agentId) {
    const state = read();
    const matched = state.mode === 'active' && (agentId ? state.active.agentIds.includes(agentId) && resources().some(r => r.id === agentId && eligible(r)) : state.active.includeGeneral);
    const features = state.mode === 'deployment' ? config : matched ? state.active : baseline;
    return { version: 1, revision: state.revision, activeRevision: state.activeRevision, mode: state.mode, matched, runtime: 'agentscope',
      contextMode: features.contextMode, contextMaxBytes: config.contextMaxBytes, retrievalMode: features.retrievalMode, evidenceReports: features.evidenceReports };
  }
  return { view, required, snapshot,
    save(user, input) {
      const { revision, draft } = z.object({ revision: revisionSchema.shape.revision, draft: draftSchema }).strict().parse(input);
      return store.transaction(() => {
        const state = authorize(user, revision);
        // Saving a draft never changes the active enhancement scope.
        const ids = new Set(resources().map(r => r.id));
        if (draft.agentIds.some(id => !ids.has(id))) throw httpError(422, '所选子领域不存在，请刷新后重试');
        return commit(user, state, 'save', { draft: { ...draft, agentIds: [...draft.agentIds].sort() }, draftRevision: state.revision + 1, preflight: null });
      });
    },
    async preflight(user, input) {
      const { revision } = revisionSchema.parse(input);
      const state = authorize(user, revision), expected = fingerprint(state.draft);
      if (checking) throw httpError(409, '已有运行时预检正在执行，请稍后刷新');
      checking = true;
      pending = (async () => {
        try {
          probe = makeDriver(config);
          await probe.warmup();
          return store.transaction(() => {
            const latest = authorize(user, revision);
            if (expected !== fingerprint(latest.draft)) throw httpError(409, '预检期间部署或子领域已变更，请重新预检');
            return commit(user, latest, 'preflight', { preflight: { draftRevision: latest.draftRevision, fingerprint: expected,
              checkedAt: now(), expiresAt: new Date(Date.now() + 300000).toISOString(), checkedBy: user.id } });
          });
        } catch (error) {
          if (!closed) store.transaction(() => {
            const latest = read();
            if (latest.revision === revision && latest.preflight) {
              store.setSetting(key, { ...latest, revision: latest.revision + 1, preflight: null, updatedAt: now(), updatedBy: user.id });
            }
            store.audit(user, 'agent.rollout.preflight_failed', key, { revision, status: error.status || 503 });
          });
          throw error.status && error.status < 500 ? error : httpError(503, 'AgentScope 本地预检失败，请检查部署解释器和 Worker 配置');
        } finally { try { await probe?.close(); } finally { probe = null; checking = false; } }
      })();
      await pending;
      return view();
    },
    activate(user, input) {
      const { revision } = revisionSchema.parse(input);
      return store.transaction(() => {
        const state = authorize(user, revision);
        if (checking) throw httpError(409, '预检正在执行，请等待完成后启用');
        if (!state.preflight || Date.parse(state.preflight.expiresAt) <= Date.now() || state.preflight.draftRevision !== state.draftRevision || state.preflight.fingerprint !== fingerprint(state.draft)) throw httpError(409, '当前草稿尚未通过有效预检，请重新预检');
        return commit(user, state, 'activate', { mode: 'active', active: state.draft, activeRevision: state.revision + 1, preflight: null });
      });
    },
    pause(user, input) {
      const { revision } = revisionSchema.parse(input);
      return store.transaction(() => commit(user, authorize(user, revision), 'pause', { mode: 'paused', preflight: null }));
    },
    async close() { closed = true; await probe?.close(); await Promise.allSettled(pending ? [pending] : []); },
  };
}

export function rolloutRoutes(app, engine) {
  app.get('/api/settings/agent-rollout', admin, (req, res) => res.json({ ...engine.rollout.view(), health: engine.health() }));
  app.put('/api/settings/agent-rollout', admin, (req, res) => res.json(engine.rollout.save(req.user, req.body)));
  for (const action of ['preflight', 'activate', 'pause']) app.post(`/api/settings/agent-rollout/${action}`, admin, async (req, res) => res.json(await engine.rollout[action](req.user, req.body)));
}
