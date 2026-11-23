ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.26
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --maxsockets=4
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS node-dependencies
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/app/.data
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund --maxsockets=4 && mkdir -p /app/.data /app/audit && chown node:node /app/.data /app/audit
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts/ops.mjs ./scripts/ops.mjs

FROM ${UV_IMAGE} AS uv-binary
FROM ${PYTHON_IMAGE} AS worker-dependencies
COPY --from=uv-binary /uv /usr/local/bin/uv
WORKDIR /app/agent-worker
COPY agent-worker/pyproject.toml agent-worker/uv.lock ./
ENV UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never UV_HTTP_TIMEOUT=120 UV_CONCURRENT_DOWNLOADS=4
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable --python /usr/local/bin/python3.12

FROM ${PYTHON_IMAGE} AS agentscope
RUN python -m pip uninstall -y pip \
    && apt-get update && apt-get install -y --no-install-recommends libstdc++6 tini && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node
COPY --from=node-dependencies /usr/local/bin/node /usr/local/bin/node
# Runtime and maintenance commands call Node directly; npm stays in build stages.
WORKDIR /app
COPY --from=node-dependencies /app /app
COPY --from=worker-dependencies /app/agent-worker /app/agent-worker
COPY agent-worker/worker.py /app/agent-worker/worker.py
COPY scripts/check-agent-worker.mjs /app/scripts/check-agent-worker.mjs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/app/.data \
    AGENT_RUNTIME=agentscope AGENTSCOPE_WORKER_MODE=prefork AGENTSCOPE_PYTHON=/app/agent-worker/.venv/bin/python
USER node
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3001/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--env-file-if-exists=.env", "server/index.mjs"]
