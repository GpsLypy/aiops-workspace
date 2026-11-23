import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { httpError } from '../store.mjs';
import { defaultPython, workerFile } from './agentscope.mjs';
import { bridgeSession } from './protocol.mjs';

const frameLimit = 2_000_000;
const unavailable = () => httpError(503, 'AgentScope 预加载进程不可用，请检查运行时状态');
const protocolError = () => httpError(502, 'AgentScope 进程池协议异常，本轮不会自动重放');
const usable = new Set(['idle', 'reserved', 'leasing', 'busy', 'finishing']);
const validUsage = value => value && ['maxRssBytes', 'cpuSeconds'].every(key => Number.isFinite(value[key]) && value[key] >= 0);

// Application-owned pool. Preloaders only read run IDs; business frames are sent
// after fork and read exclusively by a disposable child. No cross-run Agent reset.
export function createWorkerPool({ python = defaultPython, poolSize = 2, poolMaxRuns = 100, poolMaxAgeMs = 1800000, startupTimeoutMs = 15000, poolQueueMs = 30000, poolMaxPending = 100 } = {}) {
  if (process.platform === 'win32') throw new Error('AgentScope prefork requires POSIX; select AGENTSCOPE_WORKER_MODE=cold');
  const workers = new Set(), queue = [];
  const totals = { spawned: 0, completed: 0, failed: 0, cancelled: 0, recycled: 0, startupFailures: 0, queueWaitSeconds: 0, runSeconds: 0, childCpuSeconds: 0, childPeakRssBytes: 0 };
  let activated = false, closed = false, closing, restartTimer, maintenance, nextRetry = 0, consecutiveFailures = 0, lastError = null;

  function later() {
    if (closed || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; ensure(); }, Math.max(20, nextRetry - Date.now()));
    restartTimer.unref();
  }
  function ensure() {
    if (closed || !activated) return;
    if (Date.now() < nextRetry) { later(); return; }
    while (workers.size < poolSize) launch();
  }
  function removeWaiter(entry) {
    clearTimeout(entry.timer); entry.signal.removeEventListener('abort', entry.abort);
    const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
  }
  function rejectQueue(error) {
    for (const entry of [...queue]) { removeWaiter(entry); entry.reject(error); }
  }
  function pump() {
    if (closed) return;
    for (const worker of workers) {
      if (worker.phase !== 'idle' || !queue.length) continue;
      const entry = queue[0]; removeWaiter(entry);
      if (entry.signal.aborted) { entry.reject(httpError(504, '执行超时或已取消')); continue; }
      worker.phase = 'reserved'; totals.queueWaitSeconds += (performance.now() - entry.started) / 1000;
      entry.resolve(worker);
    }
    ensure();
  }
  function activate() {
    if (closed) throw unavailable();
    if (!activated) {
      activated = true;
      maintenance = setInterval(() => {
        for (const worker of workers) if (worker.phase === 'idle' && Date.now() - worker.born >= poolMaxAgeMs) worker.retire();
      }, Math.min(30000, poolMaxAgeMs));
      maintenance.unref();
    }
    ensure();
  }
  function launch() {
    const directory = mkdtempSync(join(tmpdir(), 'aiops-agent-pool-'));
    const child = spawn(resolve(python), ['-I', '-B', '-u', workerFile, '--pool'], {
      cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8', TMPDIR: directory,
        OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' },
    });
    const worker = { child, phase: 'starting', born: Date.now(), runs: 0, current: null, chain: Promise.resolve(), parentPeakRssBytes: 0 };
    workers.add(worker); totals.spawned++;
    let readyResolve, readyReject, doneResolve, killer;
    worker.ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
    worker.ready.catch(() => {}); // acquire observes startup failure via its waiter
    worker.done = new Promise(resolveDone => { doneResolve = resolveDone; });
    const decoder = new StringDecoder('utf8'); let buffer = '', bytes = 0, frames = 0;
    const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); } } };
    const stop = () => {
      child.stdin.destroy(); kill('SIGTERM');
      killer = setTimeout(() => kill('SIGKILL'), 1000); killer.unref();
    };
    worker.fail = (error, infrastructure = true) => {
      if (worker.phase === 'stopping' || worker.phase === 'stopped') return;
      const starting = worker.phase === 'starting'; worker.phase = 'stopping';
      clearTimeout(startup); readyReject(error);
      if (infrastructure) {
        lastError = error.message;
        nextRetry = Date.now() + Math.min(30000, 250 * 2 ** Math.min(consecutiveFailures++, 7));
      }
      if (starting) {
        totals.startupFailures++;
        if (![...workers].some(w => w !== worker && usable.has(w.phase))) rejectQueue(unavailable());
      }
      const current = worker.current;
      if (current) {
        clearTimeout(current.finishTimer); current.signal.removeEventListener('abort', current.abort);
        if (current.signal.aborted) totals.cancelled++; else totals.failed++;
        current.reject(error);
        try { current.onFailure?.(); } catch { /* cleanup must still complete */ }
      }
      stop();
    };
    worker.retire = () => {
      if (worker.phase !== 'idle') return;
      totals.recycled++; worker.phase = 'stopping'; stop();
    };
    const startup = setTimeout(() => worker.fail(httpError(503, 'AgentScope 预加载启动超时')), startupTimeoutMs);
    const send = async frame => {
      const line = JSON.stringify(frame) + '\n';
      if (Buffer.byteLength(line) > frameLimit) throw httpError(422, 'Agent Worker 消息超过大小限制');
      await new Promise((resolveWrite, rejectWrite) => child.stdin.write(line, error => error ? rejectWrite(error) : resolveWrite()));
    };
    const handle = async frame => {
      if (worker.phase === 'stopping' || worker.phase === 'stopped') return;
      if (frame?.version === 2 && frame.type === 'ready') {
        if (frame.sdk !== '2.0.8' || frame.pid !== child.pid || !validUsage(frame.parentUsage)) throw protocolError();
        worker.parentPeakRssBytes = frame.parentUsage.maxRssBytes;
        if (worker.phase === 'starting' && frame.runId === undefined) {
          clearTimeout(startup); worker.phase = 'idle'; consecutiveFailures = 0; nextRetry = 0; lastError = null;
          readyResolve(); pump(); return;
        }
        const current = worker.current;
        if (worker.phase !== 'finishing' || frame.runId !== current?.runId || frame.childPid !== current.childPid || !validUsage(frame.childUsage)) throw protocolError();
        clearTimeout(current.finishTimer); current.signal.removeEventListener('abort', current.abort);
        totals.completed++; totals.runSeconds += (performance.now() - current.started) / 1000;
        totals.childCpuSeconds += frame.childUsage.cpuSeconds;
        totals.childPeakRssBytes = Math.max(totals.childPeakRssBytes, frame.childUsage.maxRssBytes);
        worker.runs++; worker.current = null; worker.phase = 'idle';
        current.resolve(current.result);
        if (worker.runs >= poolMaxRuns || Date.now() - worker.born >= poolMaxAgeMs) worker.retire();
        pump(); return;
      }
      const current = worker.current;
      if (frame?.version === 2 && frame.type === 'leased') {
        if (worker.phase !== 'leasing' || frame.runId !== current?.runId || !Number.isSafeInteger(frame.pid) || frame.pid <= 0 || frame.pid === child.pid) throw protocolError();
        current.childPid = frame.pid; worker.phase = 'busy';
        await send(current.start); current.start = null; return;
      }
      if (worker.phase !== 'busy' || !current) throw protocolError();
      let result;
      try { result = await current.session(frame); }
      catch (error) { worker.fail(error.status ? error : protocolError(), false); return; }
      if (worker.phase !== 'busy' || current.signal.aborted) return;
      if (result.done) {
        current.result = result.result; worker.phase = 'finishing';
        current.finishTimer = setTimeout(() => worker.fail(httpError(502, 'AgentScope 未确认子进程已退出')), 5000);
      } else await send(result.response);
    };
    worker.execute = args => {
      if (closed || worker.phase !== 'reserved') return Promise.reject(unavailable());
      if (args.signal.aborted) return Promise.reject(httpError(504, '执行超时或已取消'));
      bytes = 0; frames = 0;
      worker.phase = 'leasing';
      return new Promise((resolveRun, rejectRun) => {
        const current = { runId: args.runId, signal: args.signal, onFailure: args.onFailure, started: performance.now(),
          session: bridgeSession(args), resolve: resolveRun, reject: rejectRun,
          start: { version: 1, type: 'start', runId: args.runId, system: args.messages[0].content, history: args.messages.slice(1), tools: args.tools.map(t => t.function) } };
        current.abort = () => worker.fail(httpError(504, '执行超时或已取消'), false);
        worker.current = current; args.signal.addEventListener('abort', current.abort, { once: true });
        send({ version: 2, type: 'lease', runId: args.runId }).catch(() => worker.fail(protocolError()));
        if (args.signal.aborted) current.abort();
      });
    };
    child.stdout.on('data', chunk => {
      if (worker.phase === 'stopping' || worker.phase === 'stopped') return;
      bytes += chunk.length; buffer += decoder.write(chunk);
      if (bytes > 16_000_000 || Buffer.byteLength(buffer) > frameLimit) { worker.fail(protocolError()); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (++frames > 256) { worker.fail(protocolError()); return; }
        worker.chain = worker.chain.then(() => handle(JSON.parse(line))).catch(error => worker.fail(error.status ? error : protocolError()));
      }
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 16_000_000) worker.fail(protocolError()); });
    child.on('error', () => worker.fail(unavailable()));
    child.once('exit', () => { if (worker.phase !== 'stopping') worker.fail(httpError(502, 'AgentScope Worker 意外退出，本轮不会自动重放')); });
    child.stdin.on('error', () => worker.fail(protocolError()));
    child.once('close', () => {
      if (worker.phase !== 'stopping') worker.fail(httpError(502, 'AgentScope Worker 意外退出，本轮不会自动重放'));
      // Kill any orphaned run child even when the preloader died first.
      kill('SIGKILL'); clearTimeout(killer); clearTimeout(startup);
      void worker.chain.finally(() => {
        worker.current = null; worker.phase = 'stopped'; workers.delete(worker);
        rmSync(directory, { recursive: true, force: true }); doneResolve(); later();
      });
    });
  }
  function acquire(signal) {
    if (signal.aborted) return Promise.reject(httpError(504, '执行超时或已取消'));
    if (closed) return Promise.reject(unavailable());
    if (queue.length >= poolMaxPending) return Promise.reject(httpError(429, 'AgentScope 进程等待队列已满'));
    activate();
    return new Promise((resolveWorker, rejectWorker) => {
      const entry = { signal, resolve: resolveWorker, reject: rejectWorker, started: performance.now() };
      entry.abort = () => { removeWaiter(entry); rejectWorker(httpError(504, '执行超时或已取消')); };
      entry.timer = setTimeout(() => { removeWaiter(entry); rejectWorker(httpError(429, 'AgentScope 进程等待超时')); }, poolQueueMs);
      queue.push(entry); signal.addEventListener('abort', entry.abort, { once: true });
      pump(); if (signal.aborted) entry.abort();
    });
  }
  return {
    async warmup() { activate(); if ([...workers].some(w => usable.has(w.phase))) return; if (!workers.size) throw unavailable(); await Promise.all([...workers].map(w => w.ready)); },
    async run(args) {
      const worker = await acquire(args.signal);
      try { return await worker.execute(args); }
      catch (error) {
        if (worker.phase === 'reserved') { worker.phase = 'idle'; pump(); }
        else if (worker.phase === 'stopping' || worker.phase === 'stopped') await worker.done;
        throw error;
      }
    },
    health() {
      return { enabled: true, mode: 'prefork', ready: !closed && [...workers].some(w => usable.has(w.phase)), size: poolSize, queued: queue.length,
        workers: [...workers].map(w => ({ pid: w.child.pid ?? null, childPid: w.current?.childPid ?? null, state: w.phase, runs: w.runs, parentPeakRssBytes: w.parentPeakRssBytes })),
        ...totals, lastError, retryAfterMs: Math.max(0, nextRetry - Date.now()) };
    },
    close() {
      if (closing) return closing;
      closed = true; clearTimeout(restartTimer); clearInterval(maintenance); rejectQueue(unavailable());
      for (const worker of workers) worker.fail(httpError(503, 'AgentScope 进程池已关闭'), false);
      closing = Promise.all([...workers].map(w => w.done)).then(() => {}); return closing;
    },
  };
}
