# Generic sibling targets: neither image contains skill content or depends on agent configuration.
FROM node:24-bookworm-slim AS runtime-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client python3 ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 agent && useradd -u 10001 -g 10001 -d /home/agent -s /bin/bash -M agent
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER 10001:10001

FROM runtime-base AS sandbox
# GitHub API access belongs to execution workers, not the orchestrator or skill resolver.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
USER 10001:10001
CMD ["node", "src/envd.ts"]

FROM runtime-base AS kaeno
# deploy.sh computes this digest from the sandbox target before building this target.
ARG SANDBOX_IMAGE
USER root
RUN node --input-type=module -e 'import {writeFileSync} from "node:fs"; const ref=process.env.SANDBOX_IMAGE; if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(ref ?? "")) throw Error("SANDBOX_IMAGE must be pinned by digest"); writeFileSync("/app/build-info.json", JSON.stringify({sandboxImage:ref}));'
USER 10001:10001
CMD ["node", "src/kaeno.ts"]
