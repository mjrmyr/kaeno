# Worker execution backends

WORK owns delegation and supervision; it does not select an execution backend. `WorkEnvironment` in `src/core/work/plan.ts` owns the resource lifecycle (`ensure`, `release`, `reconcile`, optional `capacity`) and resolves a pi-durable `ExecutionEnv` for tools. All three built-in backends use `RemoteExecutionEnv` to communicate with the execution daemon inside the sandbox.

## Configuration

Select the backend in the owner file named by `KAENO_CONFIG`. All backends use the same `{ provider, configFile }` shape:

```json
{
  "execution": {
    "provider": "docker",
    "configFile": "./docker.json"
  }
}
```

This is a fragment of the owner configuration, alongside `sourceDirectory`, `kaeno`, and `workers`. Docker settings live in the referenced `docker.json`:

```json
{
  "image": "kaeno:local",
  "cpus": 1,
  "memoryBytes": 1073741824
}
```

Copy `docker.config.example.json` to that location. An empty object uses the defaults shown above. Optional Docker settings in that file:

- `namespace`: stable owner namespace, at most 32 letters/digits/underscores/dots/hyphens, starting with a letter or digit. Defaults to a hash of the absolute database path. Separate databases, including clones, must use separate namespaces.
- `apiHost`: address where the host reaches the sandbox's loopback-published execution port; defaults to `127.0.0.1`.

Docker uses the host's Docker CLI and its configured daemon/context. Keep that daemon/context stable across restarts; the saved identity is not a physical Docker daemon identifier and cannot detect a context retargeted outside Kaeno.

For Kubernetes:

```json
{
  "execution": {
    "provider": "kubernetes",
    "configFile": "./kubernetes.json"
  }
}
```

For microsandbox:

```json
{
  "execution": {
    "provider": "microsandbox",
    "configFile": "./microsandbox.json"
  }
}
```

Copy `microsandbox.config.example.json` to that path. Its settings are `image`, `cpus`, `memoryBytes`, and optional `namespace`; defaults match Docker's image and resource defaults. The microVM runtime rounds CPUs up to whole vCPUs and memory down to whole MiB (minimum one MiB). There is no `apiHost` setting: envd is published only on host loopback. See [microsandbox requirements, images and lifecycle](microsandbox.md).

For every provider, `configFile` resolves relative to the owner config, not the working directory, and the referenced file must exist. Omitting `execution` defaults to Docker with `./docker.json` next to the owner config. Cluster-specific settings and credentials remain in the separate [Kubernetes configuration](kubernetes.md). Selecting Docker does not load Kubernetes credentials or the native microsandbox SDK, and does not contact a cluster.

Backend settings come only from the selected extension's file. `KAENO_DB`, `KAENO_WORK_MAX_DEPTH`, and `KAENO_WORK_MAX_CONCURRENT` configure the host independently of the backend.

## Recovery and switching

Every newly admitted work saves its environment's non-secret, stable identity (or `null` when embedded without an environment), including work that has not created its worker conversation yet. Startup compares every unfinished work's identity with the configured environment before resuming tasks or reconciling resources.

- Docker identity includes provider, owner namespace, and API host.
- Microsandbox identity includes provider, owner namespace, and the absolute local store path (`MSB_HOME`, default `~/.microsandbox`). Changing stores while work is unfinished is rejected; keep the host and underlying store stable as well.
- Kubernetes identity includes provider and the existing cluster/owner/resource target configuration. Image changes do not replace the image saved for an existing sandbox.
- Removing an environment or adding one to unfinished environment-free work is also a change.
- Work admitted by an older release without an environment identity fails closed. Drain it with that release before upgrading; take a consistent database backup first.

To change backends: finish or cancel all work using the old backend, let its cleanup complete, stop Kaeno, then change configuration and restart. A rejected startup does not rewrite admission identities. Restore the original configuration to resume or cancel unfinished work. This is not live migration: workspace contents and external resources are not transferred between providers.

## Composition and embedding

The host's owner-config schema validates `{ provider, configFile }` as nonempty strings, without an enum of provider names. Docker with `./docker.json` remains the default when `execution` is omitted.

Each extension exports an `ExecutionProvider` registration containing its `name` and `loadConfiguration` loader. The application explicitly installs the providers it supports:

```ts
const execution = await loadExecution(configuration.execution, databaseFile, [
  dockerExecutionProvider,
  kubernetesExecutionProvider,
  microsandboxExecutionProvider,
]);
```

The registrations come from their respective extension's public `index.ts`. `src/host/composition/execution.ts` receives this list; it imports no concrete backend. It rejects duplicate registrations and unknown configured names before invoking a loader, reporting the installed names for an unknown provider. Adding a provider requires implementing its extension and installing its registration, not changing the schema or resolver. There is no implicit installation in the resolver: embedders using the Docker default must install Docker's registration.

The resolver supplies a database-derived default namespace, execution transport factory and shared sandbox lifecycle adapter. It does not read backend files, validate provider settings, or construct providers.

Each extension owns its strict schema, defaults, file loading and construction:

- Docker: `src/extensions/docker/configuration.ts`, exported as `loadDockerConfiguration`.
- Kubernetes: `src/extensions/kubernetes/configuration.ts`, exported as `loadKubernetesConfiguration`.
- Microsandbox: `src/extensions/microsandbox/configuration.ts`, exported as `loadMicrosandboxConfiguration`.

All loaders implement `ExecutionConfigurationLoader` from `src/extensions/execution/index.ts`:

```ts
type ExecutionConfigurationLoader = (
  configFile: string,
  context: ExecutionConfigurationContext,
) => Promise<ConfiguredExecution>;
```

`ExecutionConfigurationContext` supplies `defaultNamespace`, `createEnvironment`, and `createSandboxEnvironment`; `ConfiguredExecution` contains `{ environment, extensions }`. The extension returns all native registrations it needs (currently none for Docker/microsandbox, one for Kubernetes). `src/host/main.ts` installs them and supplies the environment to `openKaeno`. Configuration selects trusted installed code; it does not discover or execute arbitrary plugins.

Embedding applications may supply any `WorkEnvironment` directly. Its required `identity` must be nonempty, non-secret, stable across equivalent restarts, and change when the backend or resource ownership target becomes incompatible. Lifecycle operations must remain idempotent after partial failures. Identity validation supplements—not replaces—the backend's resource identity checks.

Docker and microsandbox implement the shared `SandboxProvider` capability and reuse `SandboxWorkEnvironment`, both owned by `src/extensions/execution/`. Their extensions pass validated image/resources and a concrete provider to the injected adapter factory, without constructing each other's features. Kubernetes continues to implement `WorkEnvironment` directly: its durable quota reservations need the work runtime, and forcing them through the lower-level provider would add plumbing without improving the domain boundary.

## Verification

```sh
npm run verify
node scripts/work-smoke.ts docker
node scripts/work-smoke.ts microsandbox
node scripts/microsandbox-lifecycle-smoke.ts
```

The WORK smoke script takes an optional backend-file path after the provider, defaulting to the corresponding example file. Use a dedicated configuration with no explicit namespace (or a unique test owner for Kubernetes); never point the smoke script at an active application's namespace/owner. It opens a fresh database, loads the real backend through host composition, delegates a worker command, checks the guest OS/user/cwd and cleans up its work. The microsandbox lifecycle script additionally checks guest Chromium, restart adoption, stop/start, envd crash recovery, workspace persistence and orphan reconciliation against real VMs.
