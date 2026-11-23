import { validatePoCDtsResources } from './dts-config.mjs';
const emptyTables = ['resources', 'tasks', 'notification_channels', 'notification_events', 'notification_deliveries', 'runbooks'];
const internalKinds = new Set(['failed', 'cancelled', 'unknown', 'awaiting_approval']);

// Only reads the already-open database. Startup and acceptance use the same
// boundary, retaining internal chat failure records for diagnosis and restart.
export function validatePoCStore(db, { dtsConfig, decrypt } = {}) {
  for (const table of emptyTables) {
    if (table === 'resources' && dtsConfig) { validatePoCDtsResources(db, dtsConfig); continue; }
    if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n !== 0) throw new Error('PoC store contains integration, task, or notification delivery data');
  }
  if (db.prepare("SELECT count(*) AS n FROM settings WHERE key='model'").get().n !== 0) throw new Error('PoC store contains a saved model configuration');
  const effortRow = db.prepare("SELECT value FROM settings WHERE key='poc_model_reasoning_effort'").get();
  if (effortRow) {
    let value; try { value = JSON.parse(effortRow.value); } catch { throw new Error('PoC reasoning effort setting is invalid'); }
    if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'effort') || ![null, 'low', 'medium', 'high'].includes(value.effort)) throw new Error('PoC reasoning effort setting is invalid');
  }
  const timeoutRow = db.prepare("SELECT value FROM settings WHERE key='poc_model_timeouts'").get();
  if (timeoutRow) {
    let value; try { value = JSON.parse(timeoutRow.value); } catch { throw new Error('PoC model timeout setting is invalid'); }
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'firstByteTimeoutSeconds,streamIdleTimeoutSeconds' ||
      !Number.isSafeInteger(value.firstByteTimeoutSeconds) || value.firstByteTimeoutSeconds < 1 || value.firstByteTimeoutSeconds > 120 ||
      !Number.isSafeInteger(value.streamIdleTimeoutSeconds) || value.streamIdleTimeoutSeconds !== 0 && (value.streamIdleTimeoutSeconds < 60 || value.streamIdleTimeoutSeconds > 600)) {
      throw new Error('PoC model timeout setting is invalid');
    }
  }
  const notifications = db.prepare('SELECT kind,payload,status,attempts FROM notifications').all();
  const execution = db.prepare('SELECT user_id,runtime,status,input FROM executions WHERE id=?');
  const steps = db.prepare('SELECT count(*) AS n FROM tool_steps WHERE run_id=?');
  for (const record of notifications) {
    let payload;
    try { payload = JSON.parse(record.payload); } catch { /* Reject below without disclosing stored data. */ }
    if (!internalKinds.has(record.kind) || record.status !== 'pending' || record.attempts !== 0 ||
      !payload || Array.isArray(payload) || typeof payload !== 'object' ||
      Object.keys(payload).sort().join(',') !== 'runId,userId' ||
      typeof payload.runId !== 'string' || !payload.runId || typeof payload.userId !== 'string' || !payload.userId) {
      throw new Error('PoC store contains a non-internal notification record');
    }
    const run = execution.get(payload.runId);
    const toolSteps = steps.get(payload.runId).n;
    let permittedDtsSteps = false;
    if (dtsConfig && toolSteps) {
      permittedDtsSteps = db.prepare('SELECT tool,resource_id,environment,policy FROM tool_steps WHERE run_id=?').all(payload.runId).every(step => {
        const resource = db.prepare('SELECT kind,data FROM resources WHERE id=?').get(step.resource_id);
        const policy = JSON.parse(step.policy);
        return step.tool === 'dts_get_job_status' && step.environment === 'production' && resource?.kind === 'mcp' && JSON.parse(resource.data).name === 'DTS cn_east MCP' && policy.risk === 'read';
      });
    }
    let permittedDirect = false;
    if (dtsConfig && run?.runtime === 'direct' && decrypt) {
      const input = JSON.parse(decrypt(run.input));
      const resource = db.prepare('SELECT kind,owner_id,data FROM resources WHERE id=?').get(input.resourceId);
      const args = input.arguments;
      permittedDirect = input.kind === 'tool' && (input.name || input.tool) === 'dts_get_job_status' &&
        resource?.kind === 'mcp' && resource.owner_id === run.user_id && JSON.parse(resource.data).name === 'DTS cn_east MCP' &&
        typeof args?.jobid === 'string' && /^[1-9][0-9]{0,18}$/.test(args.jobid) && BigInt(args.jobid) <= 9223372036854775807n &&
        args.business_domain === 'general' && args.area_name === 'cn_east';
    }
    if (!run || run.user_id !== payload.userId || run.runtime !== 'agentscope' && !permittedDirect || run.status !== record.kind || toolSteps !== 0 && !permittedDtsSteps) {
      throw new Error('PoC internal notification does not match a tool-free AgentScope execution');
    }
  }
  return { internalFailureRecords: notifications.length };
}
