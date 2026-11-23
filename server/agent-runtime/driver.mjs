import { runAgentScope } from './agentscope.mjs';
import { createWorkerPool } from './pool.mjs';
import { probeRuntime } from './probe.mjs';
import { httpError } from '../store.mjs';

export function createRuntimeDriver(config) {
  if (config.runtime !== 'agentscope') throw new Error('Only the AgentScope runtime is supported; remove the legacy runtime configuration.');
  if (config.workerMode === 'prefork') return { ...createWorkerPool(config), version: '2.0.8/bridge-v2-prefork' };
  const controllers = new Set(), pending = new Set();
  let ready = false, closed = false, warming, completed = 0, failed = 0;
  const run = args => {
    if (closed) return Promise.reject(httpError(503, 'AgentScope 运行时已关闭'));
    const controller = new AbortController(); controllers.add(controller);
    const promise = runAgentScope({ ...args, python: config.python, signal: AbortSignal.any([args.signal, controller.signal]) })
      .then(result => { ready = true; completed++; return result; }, error => { failed++; if (error.status >= 500) ready = false; throw error; })
      .finally(() => { controllers.delete(controller); pending.delete(promise); });
    pending.add(promise); return promise;
  };
  return { version: '2.0.8/bridge-v1', run,
    warmup: async () => { if (closed) throw httpError(503, 'AgentScope 运行时已关闭'); if (ready) return; warming ||= probeRuntime(run, config.startupTimeoutMs).finally(() => { warming = null; }); await warming; },
    health: () => ({ enabled: true, mode: 'cold', ready: ready && !closed, active: pending.size, completed, failed }),
    close: async () => { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); },
  };
}

// Parents keep their prefork lease while waiting for a child. A separate cold
// driver prevents pool-size-one deadlocks and caps child processes across runs.
export function createDelegationDriver(config, limit = 3) {
  const driver = createRuntimeDriver({ ...config, workerMode: 'cold' });
  let active = 0, pending = 0, closed = false;
  const run = async args => {
    if (closed) throw httpError(503, '子 Agent 运行时已关闭');
    if (pending >= config.poolMaxPending) throw httpError(429, '子 Agent 等待队列已满');
    const started = Date.now();
    pending++;
    try {
      while (active >= limit) {
        if (closed || args.signal.aborted) throw httpError(409, '子任务已停止');
        if (Date.now() - started > config.poolQueueMs) throw httpError(429, '子 Agent 排队超时');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (closed || args.signal.aborted) throw httpError(409, '子任务已停止');
      active++;
    } finally { pending--; }
    try { return await driver.run(args); } finally { active--; }
  };
  return { version: driver.version, run,
    health: () => ({ ...driver.health(), limit, queued: pending }),
    close: async () => { closed = true; await driver.close(); },
  };
}
