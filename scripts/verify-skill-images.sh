#!/bin/sh
# Opt-in Docker smoke test. Context must contain a fixture bundle with demo/one:probe and demo/two:probe.
# Builds temporary local tags/volume only: no registry push, Git mutation or cluster deployment.
set -eu
context=${1:?Usage: verify-skill-images.sh <prepared fixture build context>}
run=$(date +%s)-$$
sandbox=kaeno-verify-sandbox:$run
kaeno=kaeno-verify-source:$run
volume=kaeno-verify-skills-$run
cleanup() {
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm "$sandbox" "$kaeno" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
docker build -q --target sandbox -t "$sandbox" "$context" >/dev/null
# A valid digest-shaped reference for metadata; these verification images are never pushed/pulled by Kubernetes.
config_digest=$(docker inspect --format '{{.Id}}' "$sandbox")
docker build -q --target kaeno --build-arg "SANDBOX_IMAGE=verify/sandbox@$config_digest" -t "$kaeno" "$context" >/dev/null
# Check EVERY saved layer, not merely the final rootfs (deleting files would otherwise mask a bad base image).
docker image save "$sandbox" | python3 -c '
import io, sys, tarfile
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as image:
    for member in image:
        if not member.isfile(): continue
        data = image.extractfile(member).read()
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as layer:
                for item in layer:
                    if item.name.lstrip("./").startswith("opt/kaeno/skills"):
                        raise SystemExit("FAIL: central skill store found in a sandbox layer")
        except tarfile.ReadError:
            pass
print("PASS: no central skill store in any sandbox image layer")
'
plan=$(docker run --rm --network none --entrypoint node "$kaeno" --input-type=module -e '
import {readFileSync} from "node:fs";
const m=JSON.parse(readFileSync("/opt/kaeno/skills/manifest.json","utf8"));
const skill=m.entries.find(s=>s.id==="demo/one:probe"); if (!skill) throw Error("fixture skill missing");
console.log(JSON.stringify([skill]));')
docker volume create "$volume" >/dev/null
# Kubernetes would apply fsGroup to the emptyDir; initialize equivalent ownership for this Docker-only test.
docker run --rm --network none --user 0 --entrypoint sh -v "$volume:/skills-out" "$sandbox" -c 'chown 10001:10001 /skills-out'
docker run --rm --network none --read-only --entrypoint node -e "KAENO_SKILL_PLAN=$plan" -v "$volume:/skills-out" "$kaeno" /app/src/materialize-skills.ts
# UID10001 main container has no full store, no unrelated skill and no ability to modify selected guidance.
docker run --rm --network none --read-only --entrypoint sh -v "$volume:/workspace/.agents/skills:ro" "$sandbox" -ec '
  test ! -e /opt/kaeno/skills
  test -f /workspace/.agents/skills/demo/one/probe/SKILL.md
  test ! -e /workspace/.agents/skills/demo/two
  test -f /workspace/.agents/skills/demo/one/probe/references/guide.md
  /workspace/.agents/skills/demo/one/probe/scripts/probe.sh
  if touch /workspace/.agents/skills/unwanted 2>/dev/null; then echo "FAIL: skill volume writable"; exit 1; fi
  echo "PASS: worker sees only assigned skills, preserves scripts/references, and mounts them read-only"
'
