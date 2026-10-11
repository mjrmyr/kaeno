#!/bin/sh
# Build the kaeno image on the homelab node, push it to the node-local registry (localhost:5000),
# and pin the new digest in the homelab repo. Commit + push the homelab repo and Flux rolls it out.
set -eu
HOST=${KAENO_BUILD_HOST:-mjrmyr@homelab}
HOMELAB=${HOMELAB_REPO:-"$(dirname "$0")/../../homelab"}
cd "$(dirname "$0")/.."
tag=$(git rev-parse --short HEAD 2>/dev/null || echo dev)$(git diff --quiet HEAD -- src Dockerfile package.json 2>/dev/null || echo -dirty)

COPYFILE_DISABLE=1 tar --no-xattrs -czf - --exclude-from=.dockerignore . | ssh "$HOST" 'rm -rf kaeno-build && mkdir kaeno-build && tar xzf - -C kaeno-build'
ref=$(ssh "$HOST" "cd kaeno-build && docker build -q -t localhost:5000/kaeno:$tag . >/dev/null \
  && docker push -q localhost:5000/kaeno:$tag >/dev/null \
  && docker inspect --format '{{index .RepoDigests 0}}' localhost:5000/kaeno:$tag")
digest=${ref#*@}
perl -pi -e "s|digest: sha256:[0-9a-f]+|digest: $digest|" "$HOMELAB/apps/kaeno/kustomization.yaml"
echo "built localhost:5000/kaeno:$tag ($digest)"
echo "pinned in $HOMELAB/apps/kaeno/kustomization.yaml"
