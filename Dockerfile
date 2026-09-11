# ============================================================
# mukti-taskplan — Render web service image (planner-only)
# Node + git + curl + the globally installed planner A2A service.
# No Chromium / opencode-browser-control.
# ============================================================
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      tar \
    && rm -rf /var/lib/apt/lists/*

# OpenCode CLI — install from npm (registry-hosted platform binaries).
# The curl installer needs api.github.com, which is rate-limited on shared CI egress.
RUN npm install -g opencode-ai@1.18.30 \
    && opencode --version

WORKDIR /app
COPY . .

# Install the planner core globally inside the image (~/.config/opencode).
RUN chmod +x scripts/*.sh global/scripts/*.js global/protocols/*.js \
      global/templates/multiagent-project/scripts/* \
    && bash scripts/install-global.sh \
    && rm -rf /tmp/*

# Render injects PORT; these defaults match the blueprint
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    DATA_DIR=/data \
    AACP_LOG_DIR=/data/logs \
    REPORTS_DIR=/data/reports \
    OPENCODE_GLOBAL_DIR=/root/.config/opencode

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "deploy/render/gateway.js"]
