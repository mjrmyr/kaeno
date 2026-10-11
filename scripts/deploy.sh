#!/bin/sh
# Resolve skills fresh, build sibling targets on the node, push, then pin kaeno. No Git push/live apply.
set -eu
HOST=${KAENO_BUILD_HOST:-mjrmyr@homelab}
HOMELAB=${HOMELAB_REPO:-"$(dirname "$0")/../../homelab"}
HOMELAB=$(cd "$HOMELAB" && pwd)
cd "$(dirname "$0")/.."
ROOT=$(pwd)
tag=$(git rev-parse --short HEAD 2>/dev/null || echo dev)$(git diff --quiet HEAD -- src scripts Dockerfile package.json package-lock.json 2>/dev/null || echo -dirty)
context=$(mktemp -d "${TMPDIR:-/tmp}/kaeno-build.XXXXXXXX")
remote=
cleanup() {
  rm -rf "$context"
  if [ -n "$remote" ]; then ssh "$HOST" "rm -rf '$remote'" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Snapshot ONCE; the live homelab configuration is never copied into the image/context.
cp "$HOMELAB/apps/kaeno/config.json" "$context/config.snapshot.json"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - --exclude-from=.dockerignore . | tar xzf - -C "$context"
node "$ROOT/scripts/build-skills.ts" "$context/config.snapshot.json" "$context/skill-bundle"
rm "$context/config.snapshot.json"
remote=$(ssh "$HOST" 'mktemp -d kaeno-build.XXXXXXXX')
# mktemp's fixed template only produces this safe path, not a shell command.
case "$remote" in kaeno-build.????????) ;; *) echo 'Unexpected remote build path' >&2; remote=; exit 1 ;; esac
case "$remote" in *[!A-Za-z0-9.-]*) echo 'Unsafe remote build path' >&2; remote=; exit 1 ;; esac
COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C "$context" . | ssh "$HOST" "tar xzf - -C '$remote'"
ref=$(ssh "$HOST" "set -eu; cd '$remote';
  docker build -q --target sandbox -t localhost:5000/kaeno-sandbox:$tag . >/dev/null;
  docker push -q localhost:5000/kaeno-sandbox:$tag >/dev/null;
  execution=\$(docker inspect --format '{{index .RepoDigests 0}}' localhost:5000/kaeno-sandbox:$tag);
  docker build -q --target kaeno --build-arg SANDBOX_IMAGE=\"\$execution\" -t localhost:5000/kaeno:$tag . >/dev/null;
  docker push -q localhost:5000/kaeno:$tag >/dev/null;
  docker inspect --format '{{index .RepoDigests 0}}' localhost:5000/kaeno:$tag")
digest=${ref#*@}
printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || { echo 'Invalid image digest' >&2; exit 1; }
perl -pi -e "s|digest: sha256:[0-9a-f]+|digest: $digest|" "$HOMELAB/apps/kaeno/kustomization.yaml"
echo "built localhost:5000/kaeno:$tag ($digest)"
echo "pinned in $HOMELAB/apps/kaeno/kustomization.yaml"
