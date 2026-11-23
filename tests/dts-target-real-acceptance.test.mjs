import assert from 'node:assert/strict';
import test from 'node:test';
import { failedPositiveSnapshot, parseArgs, selectDtsResources, validateDirectResult, within } from '../scripts/dts-target-real-acceptance.mjs';

function sourceRows() {
  const owner = 'saved-admin-id';
  const base = { status: '已启用', revision: 3, visibility: 'private', readerIds: [], managerIds: [] };
  const entries = [
    ['knowledge', 'DTS cn_east 状态说明', {}],
    ['skills', 'DTS cn_east 只读查询', { publication: 'published' }],
    ['mcp', 'DTS cn_east MCP', {
      endpoint: 'http://127.0.0.1:4111/mcp', environment: 'production', allowedTools: ['dts_get_job_status'],
      toolPolicies: { dts_get_job_status: {
        risk: 'read', roles: ['admin'], userIds: [owner], environments: ['production'],
        automatic: false, maxItems: 1,
        requiredTargetFields: ['jobid', 'business_domain', 'area_name'],
        constraints: { business_domain: ['general'], area_name: ['cn_east'] },
      } },
    }],
    ['agents', 'DTS cn_east 运维', { publication: 'published', knowledgeIds: ['id-0'], skillIds: ['id-1'], mcpIds: ['id-2'] }],
  ];
  return entries.map(([kind, name, extra], index) => ({ id: `id-${index}`, kind, owner_id: owner,
    data: JSON.stringify({ ...base, name, ...extra }) }));
}

test('saved four-resource graph and synced region policy are accepted without rewriting policy', () => {
  const rows = sourceRows();
  const policy = JSON.parse(rows[2].data).toolPolicies.dts_get_job_status;
  const selected = selectDtsResources(rows, '9007199254740993');
  assert.equal(selected.selected.length, 4);
  assert.equal(selected.owner, 'saved-admin-id');
  assert.deepEqual(selected.mcp.data.toolPolicies.dts_get_job_status, policy);
});

test('unsynced binding and a job allowlist fail closed before any live connection', () => {
  const unsynced = sourceRows();
  const mcp = JSON.parse(unsynced[2].data);
  delete mcp.toolPolicies.dts_get_job_status.requiredTargetFields;
  unsynced[2].data = JSON.stringify(mcp);
  assert.throws(() => selectDtsResources(unsynced, '123'), /three-field target binding/);
  const narrowed = sourceRows();
  const scoped = JSON.parse(narrowed[2].data);
  scoped.toolPolicies.dts_get_job_status.constraints.jobid = ['123'];
  narrowed[2].data = JSON.stringify(scoped);
  assert.throws(() => selectDtsResources(narrowed, '123'), /region-wide job scope/);
});

test('permission drift fails closed before any live connection', () => {
  const shared = sourceRows();
  const knowledge = JSON.parse(shared[0].data);
  knowledge.readerIds = ['other-user'];
  shared[0].data = JSON.stringify(knowledge);
  assert.throws(() => selectDtsResources(shared, '123'), /private owner-only/);
  const broader = sourceRows();
  const mcp = JSON.parse(broader[2].data);
  mcp.toolPolicies.dts_get_job_status.roles.push('member');
  broader[2].data = JSON.stringify(mcp);
  assert.throws(() => selectDtsResources(broader, '123'));
});

test('browser stage deadline rejects a request that never finishes', async () => {
  assert.equal(await within('browser-response-finished', 100, () => Promise.resolve('complete')), 'complete');
  await assert.rejects(within('browser-response-finished', 10, () => new Promise(() => {})),
    /browser-response-finished exceeded 10 ms/);
});

test('failed real-model snapshot keeps zero-call evidence and redacts the stored error', () => {
  const calls = [];
  const store = { get(sql, ...params) {
    calls.push({ sql, params });
    if (sql.includes('FROM executions')) return { id: 'run-1', status: 'failed', error: 'upstream secret-token' };
    return { n: 0 };
  } };
  assert.deepEqual(failedPositiveSnapshot(store, 'saved-admin-id', 0, value => value.replace('secret-token', '[REDACTED]')), {
    kind: 'real-model-real-DTS', passed: false, runId: 'run-1', executionStatus: 'failed',
    persistedToolSteps: 0, mcpCallToolCount: 0, executionError: 'upstream [REDACTED]',
  });
  assert.deepEqual(calls.map(call => call.params), [['saved-admin-id'], ['run-1']]);
});

test('direct-only mode is explicit and cannot be mistaken for real-model mode', () => {
  assert.deepEqual(parseArgs(['--direct-only', '--job', '123']), { directOnly: true, job: '123', modelOverride: null });
  assert.deepEqual(parseArgs(['--real', '--job', '123']), { directOnly: false, job: '123', modelOverride: null });
  assert.deepEqual(parseArgs(['--real', '--job', '123', '--model', 'gpt-5.6-luna']),
    { directOnly: false, job: '123', modelOverride: 'gpt-5.6-luna' });
  assert.throws(() => parseArgs(['--direct-only', '--job', '123', '--model', 'gpt-5.6-luna']));
  assert.throws(() => parseArgs(['--real', '--job', '123', '--model', 'invalid/name']));
  assert.throws(() => parseArgs(['--job', '123']));
});

test('direct SDK result accepts absent isError and verifies live target and query time', () => {
  const started = Date.now();
  const value = { fixture: false, jobid: '123', business_domain: 'general', area_name: 'cn_east', queried_at: new Date(started).toISOString() };
  assert.deepEqual(validateDirectResult({ structuredContent: value }, '123', started - 100, started + 100), {
    queriedAt: value.queried_at, fixture: false, argumentsExactlyMatched: true,
  });
  assert.throws(() => validateDirectResult({ isError: true, structuredContent: value }, '123', started, started));
  assert.throws(() => validateDirectResult({ structuredContent: { ...value, jobid: '456' } }, '123', started, started));
  assert.throws(() => validateDirectResult({ structuredContent: { ...value, queried_at: new Date(started - 10000).toISOString() } }, '123', started, started));
});
