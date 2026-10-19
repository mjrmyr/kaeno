# Worker execution backends

WORK owns delegation and supervision; it does not select a container backend. `WorkEnvironment` in `src/core/work/plan.ts` owns the resource lifecycle (`ensure`, `release`, `reconcile`, optional `capacity`) and resolves a pi-durable `ExecutionEnv` for tools. Both built-in backends use `RemoteExecutionEnv` to communicate with the execution daemon inside the sandbox.

## Configuration

Select the backend in the owner file named by `KAENO_CONFIG`. Both backends use the same `{ provider, configFile }` shape:

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

For both providers, `configFile` resolves relative to the owner config, not the working directory, and the referenced file must exist. Omitting `execution` defaults to Docker with `./docker.json` next to the owner config. Cluster-specific settings and credentials remain in the separate [Kubernetes configuration](kubernetes.md). Selecting Docker does not load Kubernetes credentials or contact a cluster.

The old variables `KAENO_KUBERNETES_CONFIG`, `KAENO_SANDBOX_NAMESPACE`, `KAENO_SANDBOX_API_HOST`, `KAENO_SANDBOX_IMAGE`, `KAENO_WORK_CPUS`, and `KAENO_WORK_MEMORY_BYTES` now fail startup with a configuration error. Move them into the referenced backend configuration file before starting this release. `KAENO_DB`, `KAENO_WORK_MAX_DEPTH`, and `KAENO_WORK_MAX_CONCURRENT` are unchanged.

## Recovery and switching

Every newly admitted work saves its environment's non-secret, stable identity (or `null` when embedded without an environment), including work that has not created its worker conversation yet. Startup compares every unfinished work's identity with the configured environment before resuming tasks or reconciling resources.

- Docker identity includes provider, owner namespace, and API host.
- Kubernetes identity includes provider and the existing cluster/owner/resource target configuration. Image changes do not replace the image saved for an existing sandbox.
- Removing an environment or adding one to unfinished environment-free work is also a change.
- Work admitted by an older release without an environment identity fails closed. Drain it with that release before upgrading; take a consistent database backup first.

To change backends: finish or cancel all work using the old backend, let its cleanup complete, stop Kaeno, then change configuration and restart. A rejected startup does not rewrite admission identities. Restore the original configuration to resume or cancel unfinished work. This is not live migration: workspace contents and external resources are not transferred between providers.

## Composition and embedding

The host's owner-config schema validates only `{ provider, configFile }`. `src/host/composition/execution.ts` selects an explicitly installed loader and supplies a database-derived default namespace and execution transport factory. It does not read backend files, validate provider settings, or construct providers.

Each extension owns its strict schema, defaults, file loading and construction:

- Docker: `src/extensions/docker/configuration.ts`, exported as `loadDockerConfiguration`.
- Kubernetes: `src/extensions/kubernetes/configuration.ts`, exported as `loadKubernetesConfiguration`.

Both loaders implement `ExecutionConfigurationLoader` from `src/extensions/execution/index.ts`:

```ts
type ExecutionConfigurationLoader = (
  configFile: string,
  context: ExecutionConfigurationContext,
) => Promise<ConfiguredExecution>;
```

`ExecutionConfigurationContext` supplies `defaultNamespace` and `createEnvironment`; `ConfiguredExecution` contains `{ environment, extensions }`. The extension returns all native registrations it needs (currently none for Docker, one for Kubernetes). `src/host/main.ts` installs them and supplies the environment to `openKaeno`. Configuration selects trusted installed code; it does not discover or execute arbitrary plugins.

Embedding applications may supply any `WorkEnvironment` directly. Its required `identity` must be nonempty, non-secret, stable across equivalent restarts, and change when the backend or resource ownership target becomes incompatible. Lifecycle operations must remain idempotent after partial failures. Identity validation supplements—not replaces—the backend's resource identity checks.

Two shapes were considered: a common lower-level `SandboxProvider` for both built-ins, or independent adapters behind `WorkEnvironment`. The latter is retained because Kubernetes's durable quota reservations need the work runtime; forcing them through Docker's lower-level provider adds plumbing without improving the domain boundary. No provider registry or additional lifecycle abstraction is needed.
