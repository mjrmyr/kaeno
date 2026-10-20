// DIFF SKETCH of RemoteExecutionEnv (src/extensions/execution/remote-env.ts).
//
//   - browser(input: object, ctx: Context): Promise<unknown> {
//   -   return this.request("/browser", input, [], ctx);
//   - }
//   + /** One MCP tool call on a work-placed server owned by this sandbox's envd. */
//   + async mcp(server: string, call: { digest: string; name: string; arguments: object }, ctx: Context): Promise<unknown> {
//   +   // TODO: try request("/mcp", { server, ...call }); on 404 and server === "browser":
//   +   //   request("/browser", { name: call.name, arguments: call.arguments })   // ONE release only (adopted old sandboxes)
//   + }
//
// The wire body is `{ server, digest, name, arguments }`; envd's WorkMcpHost re-validates it strictly.
export {};
