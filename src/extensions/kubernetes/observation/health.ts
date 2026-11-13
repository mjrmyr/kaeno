import type { ObservationFact } from "./contract.ts";

/** Kubernetes evidence only, never a claim about end-to-end availability. */
export function assess(
  fact: ObservationFact,
): "Healthy" | "Unhealthy" | "Unknown" {
  if (["Deployment", "StatefulSet", "DaemonSet"].includes(fact.kind)) {
    if (
      fact.desired === null ||
      fact.ready === null ||
      fact.updated === null ||
      fact.generation === null ||
      fact.observedGeneration === null
    ) {
      return "Unknown";
    }
    if (
      fact.observedGeneration < fact.generation ||
      fact.ready < fact.desired ||
      fact.updated < fact.desired
    ) {
      return "Unhealthy";
    }
    if (fact.kind !== "StatefulSet" && fact.available === null) {
      return "Unknown";
    }
    return fact.available !== null && fact.available < fact.desired
      ? "Unhealthy"
      : "Healthy";
  }
  if (fact.kind === "Pod") {
    if (fact.phase === "Failed" || fact.phase === "Pending") {
      return "Unhealthy";
    }
    if (fact.phase === "Succeeded") {
      return "Healthy";
    }
    if (fact.phase !== "Running" || fact.containersIncomplete) {
      return "Unknown";
    }
    const ready = fact.conditions.find(
      (entry) => entry.type === "Ready",
    )?.status;
    if (
      ready === "False" ||
      fact.containers.some(
        (entry) =>
          entry.role === "app" &&
          (entry.ready === false ||
            entry.state === "Waiting" ||
            entry.state === "Terminated"),
      )
    ) {
      return "Unhealthy";
    }
    return ready === "True" &&
      fact.containers.every(
        (entry) =>
          entry.role === "init" ||
          (entry.ready === true && entry.state === "Running"),
      )
      ? "Healthy"
      : "Unknown";
  }
  if (fact.kind === "Node") {
    if (
      fact.conditions.some((entry) =>
        entry.type === "Ready"
          ? entry.status === "False"
          : entry.status === "True",
      )
    ) {
      return "Unhealthy";
    }
    return fact.conditions.length === 4 &&
      fact.conditions.every((entry) =>
        entry.type === "Ready"
          ? entry.status === "True"
          : entry.status === "False",
      )
      ? "Healthy"
      : "Unknown";
  }
  if (fact.kind === "PersistentVolumeClaim") {
    if (fact.phase === "Bound") {
      return "Healthy";
    }
    return fact.phase === "Pending" || fact.phase === "Lost"
      ? "Unhealthy"
      : "Unknown";
  }
  if (fact.kind === "Job") {
    if (fact.failed !== null && fact.failed > 0) {
      return "Unhealthy";
    }
    if (
      fact.succeeded !== null &&
      fact.succeeded > 0 &&
      fact.active === 0 &&
      fact.failed === 0
    ) {
      return "Healthy";
    }
  }
  // A schedule or active count alone cannot establish CronJob success.
  return "Unknown";
}
