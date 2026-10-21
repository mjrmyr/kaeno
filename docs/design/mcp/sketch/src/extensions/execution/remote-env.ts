// DIFF SKETCH of RemoteExecutionEnv (src/extensions/execution/remote-env.ts).
//
//   - browser(input: object, ctx: Context): Promise<unknown> {
//   -   return this.request("/browser", input, [], ctx);
//   - }
//   + /** One MCP tool call on a work-placed server owned by this sandbox's envd. */
//   + async mcp(server: string, call: { digest: string; name: string; arguments: object }, ctx: Context): Promise<unknown> {
//   +   // TODO: return request("/mcp", { server, ...call }, [], ctx);
//   +   // A 404 means incompatible old envd: fail closed with image_skew/unavailable and
//   +   // require a new WORK sandbox. Never retry on /browser: it cannot check the digest.
//   + }
//
// The wire body is `{ server, digest, name, arguments }`; envd's WorkMcpHost re-validates it strictly.
export {};
