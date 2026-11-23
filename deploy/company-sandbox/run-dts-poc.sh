#!/bin/sh
set -eu
test "${COMPANY_SANDBOX_POC:-}" = true
test "$(id -u)" = 1000
. /home/sandbox/poc-runtime/env.sh
cd /home/sandbox/aiagent-poc
export POC_DTS_CONFIG_FILE=/workspace/poc-private/dts.json
export POC_MODEL_MAX_TOKENS="${POC_MODEL_MAX_TOKENS:-4096}"
export POC_MODEL_TEMPERATURE="${POC_MODEL_TEMPERATURE:-none}"
# All model requests require Responses SSE and a completed terminal event.
# The tunnel is independently supervised. Refuse a misleading ready application.
node --input-type=module <<'JS'
import { readPoCDtsConfig } from './deploy/company-sandbox/dts-config.mjs';
await readPoCDtsConfig(process.env.POC_DTS_CONFIG_FILE);
const response = await fetch('http://127.0.0.1:43130/health', { signal: AbortSignal.timeout(3000) });
if (!response.ok || (await response.json()).service !== 'dts-readonly-mcp') throw Error('DTS tunnel is not healthy; restore the tunnel before starting the application');
JS
exec sh deploy/company-sandbox/run-poc.sh
