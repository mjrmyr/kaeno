# One image, two roles:
#   node src/kaeno.ts  the durable orchestrator (Deployment)
#   node src/envd.ts   the execution environment inside each sandbox pod (bash, git+ssh, python3, node)
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client python3 ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 agent && useradd -u 10001 -g 10001 -d /home/agent -s /bin/bash -M agent
# A real passwd entry for uid 10001: OpenSSH (git over ssh) refuses to run for a uid without one.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER 10001:10001
CMD ["node", "src/kaeno.ts"]
