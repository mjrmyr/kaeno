// AFTER: BrowserSession and discoverBrowserTools are gone (moved to mcp/work.ts and to
// browserLockTarget). browserRequest is gone (WorkMcpHost validates against BROWSER_TOOLS).
export { browserExtension, browserLockTarget } from "./extension.ts";
export { browserRecipe, BROWSER_TOOLS } from "./recipe.ts";
