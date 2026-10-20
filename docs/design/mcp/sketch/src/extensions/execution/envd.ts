// DIFF SKETCH of src/extensions/execution/envd.ts. The execution feature stays MCP-agnostic: its
// optional capability slot is renamed from `browser` to `mcp` and its route from `/browser` to
// `/mcp`. Same shape, same 1 MB request cap, same abort-on-client-gone wiring.
//
//   - private readonly browser?: { call(input: unknown, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };
//   + private readonly mcp?:     { call(input: unknown, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };
//
//   - if (req.url === "/browser" && Buffer.byteLength(raw) > 1_000_000)
//   + if ((req.url === "/mcp" || req.url === "/browser") && Buffer.byteLength(raw) > 1_000_000)
//
//   + if (req.url === "/mcp") { if (!this.mcp) throw new Error("MCP unavailable in this environment");
//   +   const result = await this.mcp.call(input, abort.signal); ... }
//
// Image skew, the other direction: a host on the OLD code talking to a sandbox on the NEW image
// is impossible (one image, host upgraded first). A NEW host talking to a sandbox ADOPTED from
// the old image (#42) would POST /mcp to an envd that only has /browser. So the host-side
// RemoteExecutionEnv.mcp falls back to POST /browser {name, arguments} for server "browser" on
// a 404 for ONE release, then the fallback is deleted. envd keeps no alias: old images already
// serve /browser, new ones only /mcp.
//
//   /cleanup: `await this.browser?.close()` -> `await this.mcp?.close()` (all work sessions).
//
// Invariant kept: the request's abort signal fires when the host's HTTP request goes away, so a
// host crash mid-call resets that server's session (WorkMcpHost closes on any abort).
export {};
