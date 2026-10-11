#!/bin/sh
# Opt-in real Docker + Git + npx verification. Generic build context only: no config/bundle/credentials needed.
# Runtime fixtures and cache live in temporary Docker volumes, never images. No push or cluster deployment.
set -eu
context=${1:-.}
run=$(date +%s)-$$
sandbox=kaeno-verify-sandbox:$run
kaeno=kaeno-verify-runtime:$run
cache=kaeno-verify-cache-$run
fixtures=kaeno-verify-fixtures-$run
output=kaeno-verify-output-$run
cleanup() {
  docker volume rm "$cache" "$fixtures" "$output" >/dev/null 2>&1 || true
  docker image rm "$sandbox" "$kaeno" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
docker build -q --target sandbox -t "$sandbox" "$context" >/dev/null
config_digest=$(docker inspect --format '{{.Id}}' "$sandbox")
docker build -q --target kaeno --build-arg "SANDBOX_IMAGE=verify/sandbox@$config_digest" -t "$kaeno" "$context" >/dev/null
# gh is worker-only, works with an ephemeral home/read-only root, and consumes GH_TOKEN without login or network.
docker run --rm --network none --read-only --tmpfs /home/agent:uid=10001,gid=10001 --entrypoint sh \
  -e GH_TOKEN=smoke-fixture-not-a-real-token -e GH_PROMPT_DISABLED=1 "$sandbox" -ec '
  test "$(id -u)" = 10001
  gh --version
  test "$(gh auth token --hostname github.com)" = "$GH_TOKEN"
  test ! -e /home/agent/.config/gh/hosts.yml
  echo "PASS: worker gh uses environment authentication without persistent login"
'
docker run --rm --network none --read-only --entrypoint sh "$kaeno" -ec '
  ! command -v gh
  test -z "${GH_TOKEN:-}"
  echo "PASS: orchestrator image has no gh or baked GitHub token"
'
# Inspect ALL layers of BOTH images. Removing baked files later must not mask build coupling.
for image in "$sandbox" "$kaeno"; do
  docker image save "$image" | python3 -c '
import io, sys, tarfile
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as image:
    for member in image:
        if not member.isfile(): continue
        data = image.extractfile(member).read()
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as layer:
                for item in layer:
                    path = item.name.lstrip("./")
                    if path.startswith(("opt/kaeno/skills", "var/lib/kaeno/skills")) or path.endswith("/SKILL.md"):
                        raise SystemExit("FAIL: skill content found in an image layer")
        except tarfile.ReadError:
            pass
print("PASS: generic image has no skill content in any layer")
'
done
for volume in "$cache" "$fixtures" "$output"; do docker volume create "$volume" >/dev/null; done
# Kubernetes fsGroup owns its volumes; emulate this only for these temporary Docker volumes.
docker run --rm --network none --user 0 --entrypoint sh -v "$cache:/cache" -v "$fixtures:/fixtures" -v "$output:/output" "$sandbox" -c 'chown 10001:10001 /cache /fixtures /output'
docker run --rm --network none --read-only --entrypoint node -v "$fixtures:/fixtures" "$kaeno" --input-type=module -e '
import {mkdir,writeFile,chmod} from "node:fs/promises"; import {execFileSync} from "node:child_process";
for (const name of ["one","two"]) {
  const root=`/fixtures/demo/${name}.git`;
  await mkdir(`${root}/references`,{recursive:true}); await mkdir(`${root}/scripts`);
  await writeFile(`${root}/SKILL.md`,`---\nname: probe\ndescription: Fixture ${name}.\n---\nRead references/guide.md and run scripts/probe.sh.\n`);
  await writeFile(`${root}/references/guide.md`,"Use only your assigned skill.\n");
  await writeFile(`${root}/scripts/probe.sh`,"#!/bin/sh\nprintf '\''skill-probe-ok\\n'\''\n"); await chmod(`${root}/scripts/probe.sh`,0o755);
  for (const args of [["init","-q"],["add","."],["-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture"]]) execFileSync("git",args,{cwd:root});
}
await mkdir("/fixtures/bin");
await writeFile("/fixtures/bin/git","#!/bin/sh\nexec /usr/bin/git -c url.file:///fixtures/.insteadOf=https://github.com/ \"$@\"\n");
await chmod("/fixtures/bin/git",0o755);'
# Actual runtime resolution, actual pinned npx, UID10001 and readonly root. No provider/channel/Git credentials.
resolved=$(docker run --rm --read-only --entrypoint node -e PATH=/fixtures/bin:/usr/local/bin:/usr/bin:/bin \
  -v "$fixtures:/fixtures:ro" -v "$cache:/var/lib/kaeno/skills" "$kaeno" --input-type=module -e '
import {prepareSkills} from "/app/src/skill-repositories.ts";
const catalog=await prepareSkills({repositories:[{id:"demo/one"},{id:"demo/two"}],
  selections:{worker:["demo/one:*","demo/one:probe"],kaeno:["demo/two:probe"]},cacheRoot:"/var/lib/kaeno/skills"});
console.log(JSON.stringify(catalog.bind(["demo/one:probe"]).map(({id,treeHash})=>({id,treeHash}))));')
printf '%s\n' "$resolved"
plan=$(printf '%s\n' "$resolved" | tail -n 1)
# Init can read cache privately. No network; only selected output is shared with the worker.
docker run --rm --network none --read-only --entrypoint node -e "KAENO_SKILL_PLAN=$plan" \
  -v "$cache:/skill-cache:ro" -v "$output:/skills-out" "$sandbox" /app/src/materialize-skills.ts
# Repeated init converges, even with a pre-existing complete output.
docker run --rm --network none --read-only --entrypoint node -e "KAENO_SKILL_PLAN=$plan" \
  -v "$cache:/skill-cache:ro" -v "$output:/skills-out" "$sandbox" /app/src/materialize-skills.ts
docker run --rm --network none --read-only --entrypoint sh -v "$output:/workspace/.agents/skills:ro" "$sandbox" -ec '
  test ! -e /opt/kaeno/skills; test ! -e /skill-cache; test ! -e /var/lib/kaeno/skills
  test -f /workspace/.agents/skills/demo/one/probe/SKILL.md
  test ! -e /workspace/.agents/skills/demo/two
  test -f /workspace/.agents/skills/demo/one/probe/references/guide.md
  /workspace/.agents/skills/demo/one/probe/scripts/probe.sh
  if touch /workspace/.agents/skills/unwanted 2>/dev/null; then echo "FAIL: skill volume writable"; exit 1; fi
  echo "PASS: runtime installation + repeatable init; worker sees assigned skills only, has no cache mount and cannot modify guidance"
'
