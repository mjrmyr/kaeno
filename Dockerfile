FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && mkdir -p /data /workspace /home/agent \
 && chown -R node:node /data /workspace /home/agent
COPY src ./src
USER node
ENV KAENO_DB=/data/kaeno.sqlite
EXPOSE 8080
CMD ["node", "src/main.ts"]
