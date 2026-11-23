#!/bin/sh
set -eu
# Run only in a newly created company test sandbox. No .env is loaded.
test "${COMPANY_SANDBOX_POC:-}" = true || { echo 'COMPANY_SANDBOX_POC=true is required' >&2; exit 1; }
test "$(id -u)" = 1000 || { echo 'Run as UID 1000' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22||minor<16) throw Error("Node 22.16+ is required")'
python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12)'
test "$(uv --version)" = 'uv 0.11.26' || { echo 'uv 0.11.26 is required' >&2; exit 1; }
test -f package-lock.json
test -f agent-worker/uv.lock
test ! -e .env
test ! -e .data
npm ci --no-audit --no-fund --maxsockets=4
npm run build
(cd agent-worker && UV_PYTHON_DOWNLOADS=never UV_HTTP_TIMEOUT=120 uv sync --frozen --no-dev --no-editable --python python3.12)
export NODE_ENV=development DATA_DIR=/workspace/aiops-data HOST=0.0.0.0 PORT="${PORT:-3001}" AGENT_RUNTIME=agentscope AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_POOL_SIZE=1
export AGENTSCOPE_PYTHON="$(pwd)/agent-worker/.venv/bin/python"
node scripts/check-agent-worker.mjs
exec node deploy/company-sandbox/start.mjs
