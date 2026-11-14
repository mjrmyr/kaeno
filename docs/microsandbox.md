# Microsandbox worker backend

The optional [microsandbox](https://github.com/superradcompany/microsandbox) extension runs each WORK in its own microVM with its own Linux kernel. It is selectable alongside Docker and Kubernetes; Docker remains the default. Kaeno starts VMs in-process through the SDK, with no Docker daemon needed at runtime. Production SDK calls live in [`src/extensions/microsandbox/vm.ts`](../src/extensions/microsandbox/vm.ts).

Microsandbox is a single-host backend: the SDK runs VMs in the Kaeno process and has no remote API. For microVM isolation on a cluster, use the Kubernetes backend with a Kata Containers RuntimeClass instead; see [MicroVM isolation with Kata Containers](kubernetes.md#microvm-isolation-with-kata-containers).

Agents use the same execution protocol as other backends: `envd` runs in the guest, and Kaeno talks to it over HTTP with a per-work bearer token. Tools, files, browser tools and checkout do not need microVM-specific logic in core.

## Host requirements

- Linux with `/dev/kvm` (including nested virtualization when applicable), or macOS on Apple Silicon.
- Run Kaeno directly on that host (`npm start`), not inside Docker Desktop's Linux VM.
- Keep npm optional dependencies enabled: microsandbox needs its platform-specific native addon and runtime binaries.
- The SDK is beta software, pinned to exactly `0.7.8`. Upgrade deliberately and rerun the verification below.

Installing `microsandboxExecutionProvider` and loading its configuration do not import the native SDK or boot a VM. The engine loads the SDK only when resource operations are needed; selecting Docker or Kubernetes never loads it.

## Configuration

Copy `microsandbox.config.example.json` to `.kaeno/microsandbox.json`. Select it in the owner file named by `KAENO_CONFIG`:

```json
{
  "execution": {
    "provider": "microsandbox",
    "configFile": "./microsandbox.json"
  }
}
```

This fragment sits alongside the normal skills-source configuration. The path resolves relative to that owner file. The referenced file must exist; `{}` uses these defaults:

```json
{
  "image": "kaeno:local",
  "cpus": 1,
  "memoryBytes": 1073741824
}
```

| Setting       | Default                           | Purpose                                                                 |
| ------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `image`       | `kaeno:local`                     | Guest image or root filesystem supported by the SDK                     |
| `namespace`   | Hash of the `durable.sqlite` path | Stable owner scope; never share between independent databases or clones |
| `cpus`        | `1`                               | Positive vCPUs per VM, rounded up to a whole CPU                        |
| `memoryBytes` | `1073741824`                      | Integer bytes, at least one MiB, rounded down to whole MiB              |

The namespace accepts at most 32 letters/digits/underscores/dots/hyphens, starting with a letter or digit. Unknown settings are rejected. There is no `apiHost`: the execution port is always loopback-only. Backend settings belong in the extension's file.

The SDK uses `MSB_HOME`, or `~/.microsandbox` by default, for its local store. Keep that store and host stable across restarts. The provider's saved identity includes `microsandbox`, the namespace and the absolute store path, so changing stores or providers with unfinished work fails before recovery or reconciliation. This is a local-store identity, not detection of a moved/replaced underlying host or filesystem.

`microsandboxExecutionProvider` from `src/extensions/microsandbox/index.ts` registers the name `microsandbox` and the `loadMicrosandboxConfiguration` loader. That loader implements the shared `ExecutionConfigurationLoader` contract. It returns `{ environment, extensions: [] }`, using the injected transport and shared `SandboxWorkEnvironment` factories. Schemas, defaults, native engine and provider construction stay inside the microsandbox extension.

## Image

The repository [`Dockerfile`](../Dockerfile) builds the guest root filesystem with Node.js, `envd` at `/app/src/host/envd.ts`, Chromium, and writable `/workspace` and `/home/agent` for UID 1000. Use a registry reference or load a local build:

```sh
docker build -t kaeno:local .
docker save kaeno:local | npx msb load
```

Docker (or another OCI image builder) is needed only to build/export the image, not to run the microVM. The published GHCR image is linux/amd64 only, so Apple Silicon hosts need a local build. Reload an image after rebuilding it.

## Lifecycle

- Names are `kaeno-work-<namespace>-<workId>`. Labels record the exact namespace, scoped work id, image and SHA-256 of the environment token. Adoption validates these labels; identity mismatch fails rather than taking over another VM.
- VMs are detached and survive the host process exiting. A new provider reconnects, and workspace files survive VM stop/start.
- The SDK does not run the image command. Kaeno launches envd as a detached job, reboots stopped VMs, and relaunches envd when its health endpoint is unavailable. Health probes are bounded and cancellation-aware.
- Envd is published on `127.0.0.1` on a host port selected at creation and recorded in VM config for reconnection. The SDK cannot report an allocated ephemeral port, so another process claiming the port between selection and VM creation remains a possible create failure; retry with the same work identity.
- Finished work removes its VM and disk. Startup and periodic reconciliation remove orphan VMs with an **exact** matching namespace label, not just a matching name prefix. A fresh database does not contact the VM runtime merely to boot.

## Network and isolation

The microVM—not a shared-kernel Docker container—is the workload isolation boundary. Microsandbox's default `single-tenant` network policy is intended to allow public internet egress and block private networks, host addresses, loopback, link-local addresses and cloud metadata. Kubernetes NetworkPolicy does not apply here. Validate the runtime's policy against your actual LAN/tailnet, IPv6 and metadata endpoints before relying on it for untrusted workloads; do not infer a complete egress guarantee from the VM boundary or Chromium flags.

## Switching from Docker or Kubernetes

Finish or cancel all work with the original backend and let cleanup complete before stopping Kaeno and changing `execution`. Existing containers/pods are not adopted, and their files are not transferred. Older unfinished work without an environment identity must be drained with its original release. Back up SQLite consistently before upgrading. See [recovery and safe backend switching](execution.md#recovery-and-switching).

## Verification

```sh
npm run verify
node scripts/work-smoke.ts microsandbox
node scripts/microsandbox-lifecycle-smoke.ts
npx msb ls
```

The WORK smoke test loads the example backend file through host composition, delegates a real shell command, checks Linux/UID 1000/`/workspace`, and cleans up. Pass a dedicated backend-file path as its third argument to use another image. Never reuse an active application's explicit namespace/owner.

The lifecycle script uses a random test namespace and checks real Chromium navigation/JavaScript/screenshots inside the guest, reconnecting with a new provider, VM stop/start, relaunch after killing envd, workspace persistence, live-resource retention and orphan removal. Its optional first argument is an image reference. Neither script intentionally touches other applications' VMs.
