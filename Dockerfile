# syntax=docker/dockerfile:1.7
#
# Job image for the yt-agent execution pipeline (fork addition).
# Multi-arch: build with  docker buildx build --platform linux/arm64,linux/amd64 .
# Runs `node jobs/run-job.js` as a non-root user; pass the stage as arguments:
#   docker run --rm --init <image> --stage=generate --topic="..."
#
# No secrets are baked in: credentials come from SSM / environment at run time.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── deps: production node_modules with only the native modules we need built ──
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Toolchain only in this stage, as a fallback if a prebuilt native binary is unavailable for the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --ignore-scripts: no third-party install scripts run (ffmpeg-static would download a GPL binary).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild sqlite3 sharp \
 && npm cache clean --force

# ── runtime ──
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    LOG_FORMAT=json \
    FEATURE_SCHEDULER=false \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISABLE_TELEMETRY=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# ffmpeg (with libass/HarfBuzz for subtitle shaping), Kannada + Latin Noto fonts, tini as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-core fonts-noto-ui-core fontconfig tini ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Headless Chromium for Playwright rendering (matching the locked Playwright version) plus its system libraries.
RUN npx --no-install playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY --chown=root:root . .

# Non-root runtime user. Code stays root-owned and read-only; only state dirs are writable.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home app \
 && mkdir -p data logs uploads temp \
 && chown -R app:app data logs uploads temp

USER app
# No default stage on purpose: a run without --stage fails fast with exit code 30.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "jobs/run-job.js"]
