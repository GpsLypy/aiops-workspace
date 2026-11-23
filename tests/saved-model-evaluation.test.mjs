import { responsesFixture } from './responses-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApplication } from '../server/app.mjs';
import { listen } from './fixtures.mjs';

test('saved model probe uses read-only credentials and stores no response body or provider metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saved-model-probe-test-'));
  const apiKey = 'saved-model-private-test-key';
  const responseText = 'PROVIDER_PRIVATE_TEST_RESPONSE';
  const requests = [];
  const model = express(); model.use(express.json());
  model.post('/v1/responses', responsesFixture, (req, res) => {
    requests.push({ auth: req.headers.authorization, body: req.body });
    res.json({ choices: [{ message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
      usage: { total_tokens: 7, prompt_tokens: 5, completion_tokens: 2, privateMetadata: 'PRIVATE_USAGE_METADATA' } });
  });
  const http = await listen(model);
  const app = createApplication({ dataDir: dir, scheduler: false });
  const output = join(dir, 'probe.json');
  const run = async () => {
    const child = spawn(process.execPath, ['scripts/evaluate-saved-model.mjs', 'probe', '--out', output],
      { env: { ...process.env, SOURCE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', resolveCode); });
    return { code, stdout, stderr };
  };
  try {
    app.store.setSetting('model', { baseUrl: http.url + '/v1', model: 'local-probe-fixture', apiType: 'responses',
      temperature: null, apiKeyEncrypted: app.store.encrypt(apiKey) });
    const before = JSON.stringify(app.store.setting('model'));
    const first = await run(); assert.equal(first.code, 0, first.stderr);
    const bytes = readFileSync(output, 'utf8'), report = JSON.parse(bytes);
    assert.equal(report.passed, true); assert.equal(report.configurationUnchanged, true);
    assert.equal(report.stream, true); assert.match(report.answerSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.usage, { total_tokens: 7, prompt_tokens: 5, completion_tokens: 2 });
    assert.equal(statSync(output).mode & 0o077, 0);
    for (const privateValue of [apiKey, responseText, 'PRIVATE_USAGE_METADATA', http.url]) {
      assert.ok(![bytes, first.stdout, first.stderr].some(text => text.includes(privateValue)));
    }
    assert.equal(requests.length, 1); assert.equal(requests[0].auth, `Bearer ${apiKey}`);
    assert.equal(requests[0].body.stream, true);
    assert.equal(JSON.stringify(app.store.setting('model')), before);
    const second = await run(); assert.equal(second.code, 1);
    assert.equal(requests.length, 1); assert.equal(readFileSync(output, 'utf8'), bytes);
  } finally { await app.close(); await http.close(); rmSync(dir, { recursive: true, force: true }); }
});
