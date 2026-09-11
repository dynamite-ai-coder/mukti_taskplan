# ============================================================
# mukti-taskplan — Render web service image
# OpenCode + A2A registry + browser agent + gateway in one container
# ============================================================
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      curl \
      git \
      tar \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/chromium /usr/bin/chromium-browser
# opencode-browser-control detects /usr/bin/chromium-browser; CHROMIUM_USER_FLAGS
# injects --no-sandbox for root/container environments.

# OpenCode CLI
RUN curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

WORKDIR /app
COPY . .

# Install the multi-agent system globally inside the image (~/.config/opencode)
RUN chmod +x scripts/*.sh global/scripts/*.js global/protocols/*.js \
      global/templates/multiagent-project/scripts/* \
    && bash scripts/install-global.sh \
    && npm install -g opencode-browser-control \
    && (timeout 20 npx -y opencode-browser-control >/dev/null 2>&1 || true) \
    && rm -rf /tmp/*

# Render injects PORT; these defaults match the blueprint
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    DATA_DIR=/data \
    AACP_LOG_DIR=/data/logs \
    REPORTS_DIR=/data/reports \
    WORKSPACE_DIR=/data/workspace \
    OPENCODE_GLOBAL_DIR=/root/.config/opencode \
    BROWSER_NO_SANDBOX=true \
    CHROMIUM_USER_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "deploy/render/gateway.js"]
