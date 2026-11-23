import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { checkAgentWorker } from '../../scripts/check-agent-worker.mjs';
import { validatePoCStore } from './validate-store.mjs';
import { validatePoCChatEvents } from './validate-chat.mjs';

const dataDir = '/workspace/aiops-data';
const origin = `http://127.0.0.1:${process.env.PORT || 3001}`;
const access = JSON.parse(readFileSync(join(dataDir, 'poc-access.json'), 'utf8'));
const recheck = process.argv.includes('--recheck');
let cookie = '';
const request = async (path, body, headers = {}) => {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(path === '/api/chat' ? 120000 : 30000) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response;
};
const json = async (path, body) => { const response = await request(path, body); assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json(); };
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try { ready = (await json('/readyz')).ready === true; } catch { /* New instance may still be warming the SDK. */ }
  if (ready) break;
  await delay(250);
}
assert.ok(ready, 'PoC did not become ready within the startup window');
const status = await json('/poc/status');
assert.equal(status.kind, 'company-sandbox-isolated-poc'); assert.equal(typeof status.realModel, 'boolean');
assert.equal(status.schedulerStarted, false); assert.equal(status.notificationStarted, false);
assert.deepEqual(await json('/readyz'), { ready: true });
const home = await request('/'); assert.equal(home.status, 200); assert.match(await home.text(), /<div id="root"><\/div>/);
if (!(await json('/api/auth/status')).initialized) await json('/api/auth/setup', access);
const user = await json('/api/auth/login', { username: access.username, password: access.password });
assert.equal(user.username, 'poc-admin');
const db = new DatabaseSync(join(dataDir, 'aiops.sqlite'), { readOnly: true });
let prior;
try {
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  prior = db.prepare("SELECT c.id, m.content FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE m.role='assistant' ORDER BY m.seq DESC LIMIT 1").get();
  validatePoCStore(db);
} finally { db.close(); }
if (recheck) {
  assert.ok(prior, 'Missing previous PoC conversation after restart');
  const saved = await json(`/api/conversations/${prior.id}`);
  assert.equal(saved.messages.at(-1).content, prior.content);
}
for (const path of ['/api/tasks', '/api/notification-channels', '/api/resources', '/api/settings/model/test', '/api/mcp/poc/discover', '/hooks/runbooks/poc']) assert.equal((await request(path, {})).status, 403, path);
const response = await request('/api/chat', { text: status.realModel ? '请用中文简短答复：已连接公司沙箱测试环境。本轮不要调用任何工具。' : '仅验证公司沙箱隔离 PoC 流式链路', useKnowledge: false, requestKey: `company-poc-${Date.now()}` }, { Accept: 'application/x-ndjson' });
assert.equal(response.status, 200);
const events = []; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', readIndex = 0, firstDeltaRead, doneRead;
while (true) {
  const { value, done } = await reader.read(); if (done) break;
  readIndex++; buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n'); buffer = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line); events.push(event);
    if (event.type === 'message_delta' && firstDeltaRead === undefined) firstDeltaRead = readIndex;
    if (event.type === 'done') doneRead = readIndex;
  }
}
assert.equal(buffer.trim(), '', 'Unterminated NDJSON frame');
const done = validatePoCChatEvents(events, { realModel: status.realModel });
const incrementalBeforeCompletion = firstDeltaRead < doneRead;
if (!status.realModel) assert.ok(incrementalBeforeCompletion, 'Fixture answer was buffered until completion');
const saved = await json(`/api/conversations/${done.conversationId}`); assert.equal(saved.messages.at(-1).content, done.text);
const worker = await checkAgentWorker(); assert.equal(worker.ready, true);
const checkedDb = new DatabaseSync(join(dataDir, 'aiops.sqlite'), { readOnly: true });
let storeState;
try { storeState = validatePoCStore(checkedDb); } finally { checkedDb.close(); }
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), environment: 'company-sandbox-isolated-poc', uid: process.getuid(), node: process.version, workerVersion: worker.version, workerMode: worker.mode, checks: { homepage: true, readiness: true, newTestAccount: true, streamedChat: true, incrementalBeforeCompletion, chatPersisted: true, sqliteWal: true, sqliteIntegrity: true, sdkSyntheticModelTool: true, integrationsBlocked: true, isolatedIntegrationTaskNotificationState: true, restartPersistence: recheck ? true : null }, internalFailureRecords: storeState.internalFailureRecords, realModelUsed: status.realModel, realDtsUsed: false, notificationsSent: 0, productionAccepted: false };
assert.equal(report.uid, 1000);
if (process.env.POC_REPORT_FILE) writeFileSync(process.env.POC_REPORT_FILE, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(report));
