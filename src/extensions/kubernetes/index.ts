export { kubernetesExtension } from "./extension.ts";
export type {
  KubernetesConfiguration,
  KubernetesExtensionOptions,
} from "./extension.ts";
export {
  kubernetesExecutionProvider,
  loadKubernetesConfiguration,
} from "./configuration.ts";

export {
  kubernetesObservationExtension,
  KUBERNETES_OBSERVATION_TOOLS,
} from "./observation/extension.ts";
export { loadKubernetesObservationConfiguration } from "./observation/configuration.ts";
export {
  ObservationClient,
  remoteObservationClient,
} from "./observation/client.ts";

// Observer embedding API: approved facts only, never the raw Kubernetes transport.
export { KubernetesObserver } from "./observation/collector.ts";
export { observerHandler } from "./observation/server.ts";
export {
  projectFact as projectKubernetesObservation,
  factSchema as kubernetesObservationFactSchema,
  kinds as KUBERNETES_OBSERVATION_KINDS,
} from "./observation/contract.ts";
export type {
  ObservationFact,
  Snapshot as KubernetesObservationSnapshot,
} from "./observation/contract.ts";
export { assess as assessKubernetesObservation } from "./observation/health.ts";
