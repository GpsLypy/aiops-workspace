#!/bin/sh
set -eu
# Explicit fallback only. Normal bootstrap and the in-flight .venv are untouched.
test "${COMPANY_SANDBOX_POC:-}" = true
test "${POC_OFFLINE_INSTALL:-}" = true
test "$(id -u)" = 1000
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
test -n "${POC_WHEEL_PLAN_DIRECTORY:-}"
test -n "${POC_WHEEL_DIRECTORY:-}"
python3 deploy/company-sandbox/download-wheels.py --manifest "$POC_WHEEL_PLAN_DIRECTORY/wheel-plan.json" --wheel-directory "$POC_WHEEL_DIRECTORY" --verify-complete
python3 - "$POC_WHEEL_PLAN_DIRECTORY" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);plan=json.loads((root/'wheel-plan.json').read_text())
assert hashlib.sha256((root/'requirements-frozen.txt').read_bytes()).hexdigest()==plan['requirementsSha256']
PY
offline_venv=/home/sandbox/aiagent-poc/agent-worker/.venv-offline
if test -e "$offline_venv"; then
  echo 'Offline PoC venv already exists; refusing to alter it or the active worker venv' >&2
  exit 1
fi
UV_PYTHON_DOWNLOADS=never uv venv --python /home/sandbox/poc-runtime/bin/python3.12 "$offline_venv"
uv pip install --python "$offline_venv/bin/python" --offline --require-hashes --no-index --no-build --find-links "$POC_WHEEL_DIRECTORY" --strict -r "$POC_WHEEL_PLAN_DIRECTORY/requirements-frozen.txt"
uv pip check --python "$offline_venv/bin/python"
AGENTSCOPE_PYTHON="$offline_venv/bin/python" node scripts/check-agent-worker.mjs
printf 'Validated private offline Worker: %s\n' "$offline_venv/bin/python"
