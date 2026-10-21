// DIFF SKETCH of src/extensions/execution/envd.ts. The execution feature stays MCP-agnostic: its
// optional capability slot is renamed from `browser` to `mcp` and its route from `/browser` to
// `/mcp`. Same shape, same 1 MB request cap, same abort-on-client-gone wiring.
//
//   - private readonly browser?: { call(input: unknown, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };
//   + private readonly mcp?:     { call(input: unknown, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };
//
//   - if (req.url === "/browser" && Buffer.byteLength(raw) > 1_000_000)
//   + if (req.url === "/mcp" && Buffer.byteLength(raw) > 1_000_000)
//
//   + if (req.url === "/mcp") { if (!this.mcp) throw new Error("MCP unavailable in this environment");
//   +   const result = await this.mcp.call(input, abort.signal); ... }
//
// A NEW host talking to old adopted envd (#42) gets /mcp 404. Fail closed as incompatible
// (image_skew/unavailable) and require a new WORK sandbox. Never retry on /browser, which
// cannot enforce the digest. New envd serves only /mcp; there is no legacy alias.
//
//   /cleanup: `await this.browser?.close()` -> `await this.mcp?.close()` (all work sessions).
//
// Invariant kept: the request's abort signal fires when the host's HTTP request goes away, so a
// host crash mid-call resets that server's session (WorkMcpHost closes on any abort).
export {};
