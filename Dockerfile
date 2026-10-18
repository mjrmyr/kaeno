FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python-is-python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && mkdir -p /data /workspace /home/agent \
 && chown -R node:node /data /workspace /home/agent
COPY src ./src
USER node
ENV KAENO_DB=/data/kaeno.sqlite
ENV KAENO_AUTH_FILE=/data/auth.json
EXPOSE 8080
CMD ["node", "src/host/main.ts"]
