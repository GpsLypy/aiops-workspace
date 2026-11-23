import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.mjs';
import { createUser } from '../server/auth.mjs';
import { loadConfig } from '../integrations/dts-mcp/adapter.mjs';
import { provisionDts } from '../integrations/dts-mcp/provision.mjs';
import { readPoCDtsConfig } from '../deploy/company-sandbox/dts-config.mjs';
import { validatePoCStore } from '../deploy/company-sandbox/validate-store.mjs';
import { skillZip } from './skill-zip-fixture.mjs';
import { modelConfig } from '../server/model.mjs';

const config = loadConfig({ DTS_STATUS_URL: 'https://dts.example/v1/jobns/getstatus', DTS_MCP_TOKEN: 't'.repeat(40), DTS_MCP_PORT: '43130', DTS_JOB_SCOPE: 'region' });
test('environment model temperature can explicitly omit the parameter without changing saved model settings', () => {
  const previous = process.env.MODEL_TEMPERATURE;
  try {
    delete process.env.MODEL_TEMPERATURE;
    const store = { setting: () => null };
    assert.equal(modelConfig(store).temperature, 0.3);
    process.env.MODEL_TEMPERATURE = 'none'; assert.equal(modelConfig(store).temperature, null);
    process.env.MODEL_TEMPERATURE = '0.8'; assert.equal(modelConfig(store).temperature, 0.8);
    for (const value of ['NaN', '-1', '3']) { process.env.MODEL_TEMPERATURE = value; assert.throws(() => modelConfig(store)); }
    process.env.MODEL_TEMPERATURE = 'none';
    assert.equal(modelConfig({ setting: () => ({ model: 'saved', temperature: 0.7 }), decrypt: () => '' }).temperature, 0.7);
  } finally { if (previous === undefined) delete process.env.MODEL_TEMPERATURE; else process.env.MODEL_TEMPERATURE = previous; }
});
test('DTS PoC private opt-in accepts only the fixed SSH loopback endpoint and private ordinary files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-dts-config-'));
  const path = join(dir, 'dts.json');
  const value = { endpoint: 'http://127.0.0.1:43130/mcp', token: config.token, statusUrl: config.endpoint };
  try {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    assert.equal((await readPoCDtsConfig(path)).jobScope, 'region');
    for (const endpoint of ['http://10.0.0.1:43129/mcp', 'http://localhost:43130/mcp', 'http://127.0.0.1:43130/mcp?token=x']) {
      writeFileSync(path, JSON.stringify({ ...value, endpoint })); await assert.rejects(readPoCDtsConfig(path));
    }
    writeFileSync(path, JSON.stringify(value)); chmodSync(path, 0o644); await assert.rejects(readPoCDtsConfig(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('default PoC still rejects integrations; explicit DTS mode rejects widened or unrelated resources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-dts-store-'));
  let store = openStore(dir);
  createUser(store, { username: 'poc-admin', password: 'temporary-poc-admin-password' }, 'admin'); store.close();
  try {
    await provisionDts(config, { root: resolve('.'), ownerName: 'poc-admin', dataDir: dir });
    store = openStore(dir);
    assert.throws(() => validatePoCStore(store.db));
    assert.deepEqual(validatePoCStore(store.db, { dtsConfig: config }), { internalFailureRecords: 0 });
    const row = store.get("SELECT * FROM resources WHERE kind='mcp'");
    const original = JSON.parse(row.data);
    for (const change of [
      v => { v.visibility = 'public'; },
      v => { v.readerIds = ['other']; },
      v => { v.endpoint = 'http://10.0.0.1/mcp'; },
      v => { v.allowedTools.push('dts_restart'); },
      v => { v.toolPolicies.dts_get_job_status.risk = 'write'; },
      v => { v.toolPolicies.dts_get_job_status.constraints.area_name = ['cn_north']; },
      v => { v.toolPolicies.dts_get_job_status.requiredTargetFields = []; },
      v => { v.toolPolicies.dts_get_job_status.userIds.push('other'); },
    ]) {
      const next = structuredClone(original); change(next);
      store.run('UPDATE resources SET data=? WHERE id=?', JSON.stringify(next), row.id);
      assert.throws(() => validatePoCStore(store.db, { dtsConfig: config }));
    }
    store.run('UPDATE resources SET data=? WHERE id=?', row.data, row.id);
    assert.deepEqual(validatePoCStore(store.db, { dtsConfig: config }), { internalFailureRecords: 0 });
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('DTS Linux provisioning validates a prebuilt Skill ZIP before any resource is persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-dts-prebuilt-'));
  const path = join(dir, 'skill.zip');
  let store = openStore(dir);
  createUser(store, { username: 'poc-admin', password: 'temporary-poc-admin-password' }, 'admin'); store.close();
  try {
    writeFileSync(path, 'invalid ZIP');
    await assert.rejects(provisionDts(config, { root: resolve('.'), ownerName: 'poc-admin', dataDir: dir, skillPackagePath: path }));
    store = openStore(dir); assert.equal(store.get('SELECT count(*) AS n FROM resources').n, 0); store.close();
    writeFileSync(path, skillZip([['dts-status/SKILL.md', readFileSync('integrations/dts-mcp/dts-status/SKILL.md', 'utf8')]]));
    const result = await provisionDts(config, { root: resolve('.'), ownerName: 'poc-admin', dataDir: dir, skillPackagePath: path });
    assert.equal(result.resources.length, 4);
    store = openStore(dir); validatePoCStore(store.db, { dtsConfig: config });
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
