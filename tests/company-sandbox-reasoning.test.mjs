import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { modelConfig } from '../server/model.mjs';
import { listen } from './fixtures.mjs';
import { validatePoCStore } from '../deploy/company-sandbox/validate-store.mjs';

test('restricted PoC effort and timeouts survive restart without persisting model credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-effort-'));
  let application, http;
  try {
    const start = async () => {
      application = createApplication({ dataDir: dir, scheduler: false, modelSettings: { reasoningEffortOnly: true, timeoutSettingsEnabled: true } });
      http = await listen(application.app);
    };
    await start();
    const setup = await fetch(http.url + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'poc-effort-admin', password: 'poc-effort-test-password' }) });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const put = body => fetch(http.url + '/api/settings/model', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal((await fetch(http.url + '/api/settings/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"model_reasoning_effort":"high"}' })).status, 401);
    for (const effort of ['low', 'medium', 'high', null]) {
      const res = await put({ model_reasoning_effort: effort });
      assert.equal(res.status, 200); assert.equal((await res.json()).model_reasoning_effort, effort);
      assert.equal(application.store.setting('model'), null);
      validatePoCStore(application.store.db);
    }
    assert.equal((await put({ model_reasoning_effort: 'invalid' })).status, 400);
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ firstByteTimeoutSeconds: 120, streamIdleTimeoutSeconds: 0 })).status, 200);
    assert.equal(modelConfig(application.store).firstByteTimeoutSeconds, 120);
    assert.equal(modelConfig(application.store).streamIdleTimeoutSeconds, 0);
    for (const value of [0, 121, 1.5]) assert.equal((await put({ firstByteTimeoutSeconds: value })).status, 400);
    for (const value of [1, 59, 601, 60.5]) assert.equal((await put({ streamIdleTimeoutSeconds: value })).status, 400);
    for (const key of ['baseUrl', 'model', 'apiKey', 'temperature', 'apiType']) assert.equal((await put({ model_reasoning_effort: 'high', [key]: 'synthetic' })).status, 403);
    await put({ model_reasoning_effort: 'high' });
    await http.close(); http = null; await application.close(); application = null;
    await start();
    assert.equal(modelConfig(application.store).model_reasoning_effort, 'high');
    assert.equal(modelConfig(application.store).firstByteTimeoutSeconds, 120);
    assert.equal(modelConfig(application.store).streamIdleTimeoutSeconds, 0);
    assert.equal(application.store.setting('model'), null); validatePoCStore(application.store.db);
    await put({ model_reasoning_effort: null });
    assert.equal(modelConfig(application.store).model_reasoning_effort, null);
    for (const value of [{ effort: 'invalid' }, { effort: 'low', apiKey: 'synthetic' }, [], null]) {
      application.store.setSetting('poc_model_reasoning_effort', value);
      assert.throws(() => validatePoCStore(application.store.db), /reasoning effort setting is invalid/);
    }
    application.store.setSetting('poc_model_reasoning_effort', { effort: null });
    for (const value of [{ firstByteTimeoutSeconds: 0, streamIdleTimeoutSeconds: 180 }, { firstByteTimeoutSeconds: 90, streamIdleTimeoutSeconds: 30 }, { firstByteTimeoutSeconds: 90, streamIdleTimeoutSeconds: 180, apiKey: 'synthetic' }, [], null]) {
      application.store.setSetting('poc_model_timeouts', value);
      assert.throws(() => validatePoCStore(application.store.db), /model timeout setting is invalid/);
    }
  } finally { await http?.close(); await application?.close(); rmSync(dir, { recursive: true, force: true }); }
});
