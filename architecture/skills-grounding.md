# Kaeno skill architecture grounding

Historical grounding only: the exploration below predates the implemented runtime architecture. Build-time resolution/store-bearing images are SUPERSEDED. Current authority is `skills.md` and `runtime-skills-plan.md`: generic images, startup Git/npx preparation on a persistent dedicated cache PVC, and private init copying only assigned skills into `/workspace/.agents/skills`. Original requirements below are decision history, not implementation instructions.

## Agreed requirements
Top-level skillRepositories: ["poteto/p-stack:v0.2.4", "mattpocock/skills"]. Agent template skills: ["poteto/p-stack:poteto-mode", "mattpocock/skills:grill-me"]. Repo version optional; absent means default branch HEAD at each build, not latest release. Pinned means fetch exact Git ref, fail if absent. Selection omits repository version. Reject same repo twice (even different refs). Use npx skills add for installation. Resolve at build time, not agent startup. No lockfile constraining future builds; record resolved commit hashes as provenance. No tool/credential permissions inferred from skills.

## Overview / existing rationale
One pi-durable Harness owns conversations and tasks in SQLite, all tool operations for sandboxed agents go via RemoteExecutionEnv to envd in a per-child pod. Kaeno itself has no file/shell tools/env. This protects the host credentials and cluster permissions. Any skill mechanism must preserve that separation. No current skill discovery exists in pi-durable (coding-agent discovery is NOT automatically active).

## Where things live / flow
src/config.ts: parseConfig validates raw JSON once into Config (agent, templates, telegram, schedules). Template has model, thinking, instructions, sandbox, tools (read/write/edit/bash), delegates. No skill fields yet. All CodingTools require sandbox.
src/agents.ts: createAgents exposes Kaeno extension, agentChange, env, sweep, shutdown. agentChange creates AgentChange with selected CodingTools + delegate, instructions and cwd. delegate commits child + AgentState (template, sandbox pod+token), configures it once; rerun finds owned child without reconfiguring. createPod always uses image() CURRENT orchestrator image, so existing pod remains old image through 409 but a missing pod recreated after image upgrade uses new image. This is a replay consistency risk for skill bundles. env reads sandbox from AgentState and connects remote. Skill prompts must not assume current host files match surviving old sandbox files. Child skill assignment should be frozen when created. Thread skill selection follows thread configuration refresh policy.
src/threads.ts: thread commits ownerless conversation and AgentState.template; refreshThreads re-applies current root template at startup, including potentially active threads. Need explicit migration policy for skill selection in these threads.
src/kaeno.ts: load config from /etc/kaeno/config.json (ConfigMap). Determine own image via pod spec; install CodingTools+Kaeno; open storage; refreshThreads then resume. Integrate startup validation before resume.
src/k8s.ts: sandboxPod command node /app/src/envd.ts, image current kaeno image; read-only root, workspace/home/tmp emptyDirs, GitHub SSH Secret. No mounts over /app or possible /opt/kaeno/skills.
Dockerfile: node24 image, npm ci prod --ignore-scripts, COPY src, UID10001, same image kaeno+envd. Need COPY skill bundle; npx installer build-side only.
.dockerignore: excludes node_modules,.git,docs,architecture,test,pi-extension. deploy tar uses this list, so exact generated bundle must enter context and survive tar.
scripts/deploy.sh: tar local repo to ssh homelab, docker build+push, pin digest in sibling homelab/apps/kaeno/kustomization.yaml. Config resides ONLY in homelab/apps/kaeno/config.json (not in kaeno tar). Must read/snapshot same config for skill bundle and record/verify compatibility at runtime. Build must re-resolve unpinned refs before Docker layer cache. Do not deploy, push, commit, change live config in this task without explicit permission.
Tests: 32 passed previously: env conformance, durable delegation mid-command crash/reopen with same pod, Telegram+cron, config. Desired skill test: fake model reads assigned SKILL.md and runs bundled script via real envd, no cloud cost. Cross-repo collisions, unknown/missing, repeated builds, bad refs, manifest/config drift, rebuild during active child need tests.

## External CLI evidence
npm skills latest checked 1.7.2 (repo vercel-labs/skills). Downloaded v1.7.2 source parser supports local paths and fragments #ref in git sources; colon version is KAENO config syntax, NOT something we can blindly pass to npx. Installer supports --skill, --agent pi, --copy, --yes; pi project directory .agents/skills. Names metadata drive selection; normalized/sanitized installer destination may differ; do NOT assume requested name maps to installed directory without scanning metadata. Isolate each repo invocation to prevent cross-repo collisions. Clone/check out exact revision once then npx skills@1.7.2 add <absolute-checkout-path> --skill <selected names> --agent pi --copy --yes is viable design; verify CLI source local install handling. npx external executable should be pinned even for unpinned skill refs. CLI may omit files (e.g. .git) and sanitizes names; inspect installed metadata and create manifest.
No actual fetch of poteto/p-stack:v0.2.4 could be verified: git ls-remote HTTPS failed auth (could be private/missing). Do not silently fallback to another ref. Private build repo auth is separate from sandbox GitHub SSH key. Public repo actual integration can use mattpocock/skills.

## Candidate rubric
1. Agreed config/build semantics, including latest not cached, qualified names, exact pin, absent skill fail.
2. Deep small interface, no duplicated authority, fits existing files, short trace.
3. Frozen per-child assignment and assets across orchestrator image upgrades/replays (including missing pod).
4. Boundary/security: safe argv, scoped tool, path/symlinks, no cloud secret exposure, third-party trust.
5. Tests that falsify design and clear implementation order; installation backed by CLI evidence.

Do not read deleted docs or git history. Do not change code or live cluster. Produce architecture only in your response; parent captures stdout in isolated candidate directory.
