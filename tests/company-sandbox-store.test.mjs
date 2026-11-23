import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { createApplication } from '../server/app.mjs';
import { createUser } from '../server/auth.mjs';
import { listen } from './fixtures.mjs';
import { validatePoCStore } from '../deploy/company-sandbox/validate-store.mjs';
import { validatePoCChatEvents } from '../deploy/company-sandbox/validate-chat.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'company-poc-store-'));
  const store = openStore(dir);
  store.run("INSERT INTO users VALUES('poc-user','poc-user','PoC','unused-test-hash','admin',1,'2026-10-08')");
  const run = (kind = 'failed', id = 'test-run') => store.run('INSERT INTO executions(id,user_id,request_key,input_hash,input,status,created,updated,runtime) VALUES(?,?,?,?,?,?,?,?,?)', id, 'poc-user', id, 'test-hash', 'test-input', kind, '2026-10-08', '2026-10-08', 'agentscope');
  const notification = (kind = 'failed', id = 'test-record', runId = 'test-run') => store.run('INSERT INTO notifications(id,kind,payload,created) VALUES(?,?,?,?)', id, kind, JSON.stringify({ runId, userId: 'poc-user' }), '2026-10-08');
  return { dir, store, run, notification, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('PoC store permits only exact internal no-tool failure records and does not mutate them', () => {
  const h = fixture();
  try {
    assert.deepEqual(validatePoCStore(h.store.db), { internalFailureRecords: 0 });
    for (const kind of ['failed', 'cancelled', 'unknown', 'awaiting_approval']) {
      h.run(kind, kind); h.notification(kind, kind, kind);
    }
    const before = h.store.all('SELECT * FROM notifications ORDER BY id');
    const readOnly = new DatabaseSync(join(h.dir, 'aiops.sqlite'), { readOnly: true });
    try { assert.deepEqual(validatePoCStore(readOnly), { internalFailureRecords: 4 }); } finally { readOnly.close(); }
    assert.deepEqual(h.store.all('SELECT * FROM notifications ORDER BY id'), before);
  } finally { h.close(); }
});

test('PoC store rejects arbitrary notifications, mismatched executions, tools and attempted deliveries', () => {
  const mutations = [
    ["UPDATE notifications SET kind='arbitrary'", /non-internal/],
    ["UPDATE notifications SET status='sent'", /non-internal/],
    ["UPDATE notifications SET attempts=1", /non-internal/],
    ["UPDATE notifications SET payload='invalid-json'", /non-internal/],
    ["UPDATE notifications SET payload='null'", /non-internal/],
    ["UPDATE notifications SET payload='[]'", /non-internal/],
    ["UPDATE notifications SET payload='{}'", /non-internal/],
    [`UPDATE notifications SET payload='{"runId":"test-run","userId":"poc-user","extra":"PRIVATE_RECORD"}'`, /non-internal/],
    [`UPDATE notifications SET payload='{"runId":"test-run","userId":"other-owner"}'`, /does not match/],
    [`UPDATE notifications SET payload='{"runId":"missing-run","userId":"poc-user"}'`, /does not match/],
    ["UPDATE executions SET runtime='direct'", /does not match/],
    ["UPDATE executions SET status='success'", /does not match/],
    ["INSERT INTO tool_steps(id,run_id,resource_id,resource_revision,tool,arguments_encrypted,environment,policy,status,created,updated,expires) VALUES('step','test-run','synthetic',1,'tool','x','test','{}','failed','now','now',0)", /does not match/],
  ];
  for (const [sql, reason] of mutations) {
    const h = fixture();
    try {
      h.run(); h.notification(); h.store.run(sql);
      assert.throws(() => validatePoCStore(h.store.db), error => reason.test(error.message) && !error.message.includes('PRIVATE_RECORD'), sql);
    } finally { h.close(); }
  }
});

test('PoC store keeps integration, task, channel, event, delivery, runbook and model-setting bans', () => {
  const mutations = [
    "INSERT INTO resources VALUES('r','mcp','poc-user','{}','now','now')",
    "INSERT INTO tasks(id,user_id,name,prompt,schedule_type,timezone,enabled,created,updated) VALUES('t','poc-user','t','t','once','UTC',0,'now','now')",
    "INSERT INTO notification_channels(id,name,kind,config_encrypted,created,updated) VALUES('c','c','webhook','private','now','now')",
    "INSERT INTO notification_events(id,source_key,kind,user_id,payload,created) VALUES('e','e','test','poc-user','{}','now')",
    // FK checks may be disabled only in this disposable fixture to exercise an
    // orphan delivery as well; the validator must reject any delivery row.
    "INSERT INTO notification_deliveries(id,event_id,channel_id,channel_revision,created,updated) VALUES('d','e','c',1,'now','now')",
    "INSERT INTO runbooks(id,name,owner_id,revision,publication,data,created,updated) VALUES('b','b','poc-user',1,'draft','{}','now','now')",
    "INSERT INTO settings VALUES('model','{}')",
  ];
  for (const sql of mutations) {
    const h = fixture();
    try {
      h.store.db.exec('PRAGMA foreign_keys=OFF'); h.store.run(sql);
      assert.throws(() => validatePoCStore(h.store.db), /PoC store contains/, sql);
    } finally { h.close(); }
  }
});

test('PoC chat validation reports NDJSON errors before inspecting done or answer chunks without exposing details', () => {
  for (const events of [
    [{ type: 'error', error: 'PRIVATE_MODEL_FAILURE' }],
    [{ type: 'message_delta', text: 'partial' }, { type: 'done', text: 'complete' }, { type: 'error', error: 'PRIVATE_MODEL_FAILURE' }],
  ]) assert.throws(() => validatePoCChatEvents(events, { realModel: true }), error => /returned an error event/.test(error.message) && !error.message.includes('PRIVATE_MODEL_FAILURE'));
  const complete = [{ type: 'message_delta', text: 'finished' }, { type: 'done', text: 'finished' }];
  assert.equal(validatePoCChatEvents(complete, { realModel: true }), complete[1]);
  assert.throws(() => validatePoCChatEvents([{ type: 'message_delta', text: 'partial' }]), /Missing completed chat/);
});

test('a real failed no-tool chat survives PoC store validation and application restart, then a retry succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'company-poc-restart-'));
  let fail = true;
  const modelApp = express(); modelApp.use(express.json());
  modelApp.post('/v1/responses', (req, res) => {
    if (fail) return res.status(503).json({ error: 'PRIVATE_MODEL_FAILURE' });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    res.type('text/event-stream').end(frame({ type: 'response.output_text.delta', delta: '公司沙箱' }) + frame({ type: 'response.output_text.delta', delta: '重启恢复验证成功' }) + frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '公司沙箱重启恢复验证成功' }] }] } }));
  });
  const model = await listen(modelApp);
  const overrides = { MODEL_BASE_URL: model.url + '/v1', MODEL_NAME: 'poc-restart-fixture', MODEL_API_TYPE: 'responses', MODEL_API_KEY: '', OUTBOUND_ALLOWED_ORIGINS: model.url, OUTBOUND_HTTP_ORIGINS: model.url, OUTBOUND_PRIVATE_ORIGINS: model.url };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let app, http;
  try {
    app = createApplication({ dataDir: dir, scheduler: false, agentRuntime: { workerMode: 'cold' } });
    createUser(app.store, { username: 'poc-admin', password: 'poc-restart-test-password' }, 'admin');
    http = await listen(app.app);
    const login = await fetch(http.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'poc-admin', password: 'poc-restart-test-password' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    const chat = async requestKey => {
      const response = await fetch(http.url + '/api/chat', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ text: '只验证聊天，不调用工具', useKnowledge: false, requestKey }), signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    };
    const failed = await chat('poc-failed-chat');
    assert.ok(failed.some(event => event.type === 'error'));
    assert.equal(failed.some(event => event.type === 'done'), false);
    assert.equal(app.store.get("SELECT status FROM executions WHERE request_key='poc-failed-chat'").status, 'failed');
    assert.equal(app.store.get('SELECT count(*) AS n FROM tool_steps').n, 0);
    const records = app.store.all('SELECT * FROM notifications'); assert.equal(records.length, 1);
    const errorMessages = app.store.all("SELECT * FROM messages WHERE role='error'"); assert.equal(errorMessages.length, 1);
    assert.deepEqual(validatePoCStore(app.store.db), { internalFailureRecords: 1 });
    await http.close(); http = null; await app.close(); app = null;
    const readOnly = new DatabaseSync(join(dir, 'aiops.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(validatePoCStore(readOnly), { internalFailureRecords: 1 });
      assert.deepEqual(readOnly.prepare('SELECT * FROM notifications').all(), records);
      assert.deepEqual(readOnly.prepare("SELECT * FROM messages WHERE role='error'").all(), errorMessages);
    } finally { readOnly.close(); }
    app = createApplication({ dataDir: dir, scheduler: false, agentRuntime: { workerMode: 'cold' } }); http = await listen(app.app); fail = false;
    const recovered = await chat('poc-recovered-chat');
    assert.equal(validatePoCChatEvents(recovered, { realModel: true }).text, '公司沙箱重启恢复验证成功');
    assert.deepEqual(validatePoCStore(app.store.db), { internalFailureRecords: 1 });
    assert.deepEqual(app.store.all('SELECT * FROM notifications'), records);
    assert.deepEqual(app.store.all("SELECT * FROM messages WHERE role='error'"), errorMessages);
  } finally {
    if (http) await http.close(); if (app) await app.close(); await model.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
