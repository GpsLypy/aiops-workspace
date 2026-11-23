import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { httpError } from '../store.mjs';
import { bridgeSession } from './protocol.mjs';

export const workerFile = fileURLToPath(new URL('../../agent-worker/worker.py', import.meta.url));
export const defaultPython = fileURLToPath(new URL('../../agent-worker/.venv/bin/python', import.meta.url));
const limit = 2_000_000;

// A private parent/child pipe is the v1 transport and authentication boundary.
// No HTTP listener, inherited provider secrets, shared process, or auto-restart.
export async function runAgentScope({ runId, messages, tools, model, tool, signal, onFailure = () => {}, python = defaultPython }) {
  if (signal.aborted) throw httpError(504, '执行超时或已取消');
  const directory = mkdtempSync(join(tmpdir(), 'aiops-agent-worker-'));
  const child = spawn(resolve(python), ['-I', '-B', '-u', workerFile], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8', TMPDIR: directory },
  });
  const decoder = new StringDecoder('utf8');
  let buffer = '', total = 0, count = 0, settled = false, finishing = false;
  let chain = Promise.resolve(), killer;
  const session = bridgeSession({ runId, model, tool });
  const stop = () => {
    child.stdin.destroy();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 1000); killer.unref();
  };
  const closed = new Promise(resolveClose => child.once('close', () => { clearTimeout(killer); resolveClose(); }));
  try {
    return await new Promise((resolveRun, reject) => {
      const fail = error => { if (settled) return; settled = true; stop(); reject(error); onFailure(); };
      const send = async data => {
        const line = JSON.stringify(data) + '\n';
        if (Buffer.byteLength(line) > limit) throw httpError(422, 'Agent Worker 消息超过大小限制');
        await new Promise((resolveWrite, rejectWrite) => child.stdin.write(line, error => error ? rejectWrite(error) : resolveWrite()));
      };
      const onAbort = () => fail(httpError(504, '执行超时或已取消'));
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('close', () => signal.removeEventListener('abort', onAbort));
      child.on('error', () => fail(httpError(503, 'AgentScope Worker 无法启动，请检查 Python 环境')));
      child.stdin.on('error', () => { if (!finishing) fail(httpError(502, 'AgentScope Worker 连接已关闭')); });
      child.stderr.on('data', chunk => { total += chunk.length; if (total > 16_000_000) fail(httpError(502, 'AgentScope Worker 输出超过限制')); });
      const handle = async frame => {
        if (settled || signal.aborted) return;
        const output = await session(frame);
        if (signal.aborted || settled) return;
        if (output.done) { finishing = true; settled = true; stop(); resolveRun(output.result); }
        else await send(output.response);
      };
      child.stdout.on('data', chunk => {
        total += chunk.length; buffer += decoder.write(chunk);
        if (total > 16_000_000 || Buffer.byteLength(buffer) > limit) { fail(httpError(502, 'AgentScope Worker 输出超过限制')); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (++count > 256) { fail(httpError(502, 'AgentScope Worker 事件过多')); return; }
          chain = chain.then(() => handle(JSON.parse(line))).catch(error => fail(error.status ? error : httpError(502, 'AgentScope Worker 协议错误')));
        }
      });
      child.once('close', () => { if (!settled) fail(httpError(502, 'AgentScope Worker 意外退出，本轮不会自动重放')); });
      try {
        send({ version: 1, type: 'start', runId, system: messages[0].content, history: messages.slice(1), tools: tools.map(t => t.function) }).catch(error => fail(error.status ? error : httpError(502, 'AgentScope Worker 连接已关闭')));
        if (signal.aborted) onAbort();
      } catch (error) { fail(error); }
    });
  } finally {
    await closed;
    await chain;
    rmSync(directory, { recursive: true, force: true });
  }
}
