#!/bin/sh
set -eu
test "${COMPANY_SANDBOX_POC:-}" = true
test "$(id -u)" = 1000
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
export NODE_ENV=development HOST=0.0.0.0 PORT=3001 DATA_DIR=/workspace/aiops-data
export AGENTSCOPE_PYTHON=/home/sandbox/aiagent-poc/agent-worker/.venv/bin/python
export AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_POOL_SIZE=1
export POC_REAL_MODEL_CONFIG_FILE=/workspace/poc-private/model.json
umask 077
mkdir -p /workspace/poc-logs
if test -f /workspace/poc-logs/poc.pid; then
  previous_pid=$(cat /workspace/poc-logs/poc.pid)
  if kill -0 "$previous_pid" 2>/dev/null; then
    echo 'PoC PID is still alive; inspect and stop only that process before restarting' >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > /workspace/poc-logs/poc.pid
exec node deploy/company-sandbox/start.mjs
