# microsandbox worker backend

The default worker execution backend. Each WORK runs in its own [microsandbox](https://github.com/superradcompany/microsandbox) microVM, with its own Linux kernel; the VM, not a shared-kernel container, is the isolation boundary. Kaeno starts VMs in-process through the microsandbox SDK: there is no daemon or container runtime involved at run time. All microsandbox calls live in [`src/extensions/microsandbox/vm.ts`](../src/extensions/microsandbox/vm.ts).

Agents interact with a VM exactly as with any other backend: `envd` runs inside the guest and Kaeno talks to it over HTTP with the per-work bearer token, so tools, files, cancellation, browser tools and GitHub checkout are unchanged.

## Host requirements

- Linux with `/dev/kvm` (virtual machines need nested virtualization), or macOS on Apple Silicon.
- Run Kaeno directly on that host (`npm start`), not inside a container: Docker Desktop's Linux VM cannot start microVMs.
- microsandbox is beta software. The `microsandbox` npm dependency is pinned to an exact version; upgrade it deliberately and rerun the verification below.

## Image

The guest root filesystem is an OCI image. The repository [`Dockerfile`](../Dockerfile) builds it: Node.js, `envd` at `/app/src/host/envd.ts`, Chromium, and writable `/workspace` and `/home/agent` for UID 1000. `KAENO_SANDBOX_IMAGE` selects it (default `kaeno:local`). Use a registry reference, or load a local build once per rebuild:

```sh
docker build -t kaeno:local .
docker save kaeno:local | npx msb load
```

Docker (or Podman/Buildah) is only needed to build the image. The published GHCR image is linux/amd64 only, so Apple Silicon hosts need a local build.

## Configuration

| Variable                  | Default                     | Purpose                                                             |
| ------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `KAENO_SANDBOX_IMAGE`     | `kaeno:local`               | Guest image                                                         |
| `KAENO_SANDBOX_NAMESPACE` | hash of the `KAENO_DB` path | Owner scope for VM names and cleanup; never share between databases |
| `KAENO_WORK_CPUS`         | `1`                         | vCPUs per VM, rounded up to a whole CPU                             |
| `KAENO_WORK_MEMORY_BYTES` | `1073741824`                | Guest memory per VM; pages are allocated as the guest touches them  |

## Lifecycle

- VMs are named `kaeno-work-<namespace>-<workId>` and labeled with the work id, image and a SHA-256 of the environment token. Retries and restarts adopt only a VM whose labels match the saved identity; a mismatch fails instead of adopting.
- VMs are detached: they keep running when Kaeno exits, and a restarted Kaeno reconnects to them. Files in `/workspace` live on the VM's own disk and survive stop/start.
- microsandbox does not run the image command for SDK-created VMs, so `envd` is started as a detached job. Processes do not survive a VM stop, so `ensure` boots a stopped VM and relaunches `envd` whenever `/healthz` does not answer.
- `envd` is published on `127.0.0.1` only, on a host port Kaeno picks at creation; the VM configuration records it for reconnection.
- Finished work removes its VM and disk. Startup and the periodic WORK reconciler remove namespace-owned VMs that no longer belong to live work.

## Network

microsandbox applies its default `single-tenant` policy: public internet allowed; private networks, the host, loopback, link-local addresses and cloud metadata endpoints blocked. Verified: GitHub reachable; `192.168.0.0/16`, `10.0.0.0/8`, `169.254.169.254` and the host refused. Other ranges (for example tailnet `100.64.0.0/10`) are not verified; check them against your network before relying on them. Kubernetes NetworkPolicy does not apply to this backend.

## Upgrading from Docker

Earlier releases ran WORK in Docker containers. Drain or cancel unfinished work and back up SQLite before upgrading: existing containers are not adopted. Remove leftovers once:

```sh
docker rm -f $(docker ps -aq --filter label=kaeno.io/managed-work=true)
docker volume ls -q --filter name=kaeno-workspace- | xargs -r docker volume rm
```

## Verification

```sh
npm run verify
KAENO_SANDBOX_IMAGE=kaeno:local node scripts/work-smoke.ts
```

The smoke test delegates a WORK that runs `bash` inside a real VM and removes it afterwards; `npx msb ls` should then list no `kaeno-work-*` VMs.
