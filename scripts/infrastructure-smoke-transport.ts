import assert from "node:assert/strict";

// kubectl selects its JSON decoder when stdin starts with `{`. YAML separators
// between JSON objects are therefore not a valid multi-resource input.
export function kubernetesList(objects: unknown[]): string {
  return JSON.stringify({ apiVersion: "v1", kind: "List", items: objects });
}

export async function readyDockerHostUrl(
  docker: (...args: string[]) => Promise<string>,
  host: string,
): Promise<string | undefined> {
  assert.equal(
    await docker("inspect", "--format", "{{.State.Running}}", host),
    "true",
    "normal image entrypoint exited",
  );
  // Docker may reallocate an ephemeral published port when restarting a container.
  const published = await docker("port", host, "8080/tcp");
  const url = `http://${published.split("\n")[0]}`;
  const healthy = await fetch(`${url}/healthz`, {
    signal: AbortSignal.timeout(2_000),
  }).then(
    (response) => response.ok,
    () => false,
  );
  return healthy ? url : undefined;
}
