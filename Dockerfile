FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python-is-python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# npm lifecycle scripts remain disabled. Install the Chromium revision and OS
# dependencies explicitly using the CLI from the exact locked runtime package.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm ci --omit=dev --ignore-scripts \
 && ./node_modules/.bin/playwright install --with-deps chromium \
 && chmod -R a+rX /opt/playwright \
 && rm -rf /var/lib/apt/lists/* \
 && npm cache clean --force \
 && mkdir -p /data /workspace /home/agent \
 && chown -R node:node /data /workspace /home/agent
COPY src ./src
COPY scripts/browser.mjs scripts/browser-smoke.mjs ./scripts/
USER node
ENV KAENO_DB=/data/kaeno.sqlite
ENV KAENO_AUTH_FILE=/data/auth.json
EXPOSE 8080
CMD ["node", "src/host/main.ts"]
