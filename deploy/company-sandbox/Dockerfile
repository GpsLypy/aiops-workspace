# Build the base from the root Dockerfile first. A local runtime image may be
# reused only after its Node/Python/uv.lock versions have been verified.
ARG AIOPS_IMAGE=aiagent-poc-20261008-base:latest
FROM ${AIOPS_IMAGE}
USER root
WORKDIR /app
COPY agent-worker/uv.lock /tmp/poc-worker.lock
RUN node -e "const fs=require('node:fs'),c=require('node:crypto'); const hash=p=>c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); if(hash('/tmp/poc-worker.lock')!==hash('/app/agent-worker/uv.lock'))throw Error('Reused image does not match current uv.lock'); const [a,b]=process.versions.node.split('.').map(Number); if(a!==22||b<16)throw Error('Node 22.16+ required')" \
    && /app/agent-worker/.venv/bin/python -c "import sys,importlib.metadata; assert sys.version_info[:2]==(3,12); assert importlib.metadata.version('agentscope')=='2.0.8'"
# Refresh application source even when reusing a verified SDK runtime image.
COPY server ./server
COPY dist ./dist
COPY agent-worker/worker.py agent-worker/pyproject.toml agent-worker/uv.lock ./agent-worker/
COPY scripts/check-agent-worker.mjs scripts/model-billing.mjs ./scripts/
COPY deploy/company-sandbox ./deploy/company-sandbox
RUN mkdir -p /workspace/aiops-data && chown 1000:1000 /workspace /workspace/aiops-data
ENV NODE_ENV=development HOST=0.0.0.0 PORT=3001 DATA_DIR=/workspace/aiops-data \
    AGENT_RUNTIME=agentscope AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_POOL_SIZE=1 \
    AGENTSCOPE_PYTHON=/app/agent-worker/.venv/bin/python COMPANY_SANDBOX_POC=true
USER 1000:1000
EXPOSE 3001
CMD ["node", "deploy/company-sandbox/start.mjs"]
