/**
 * The editor tool list exactly as the host advertises it, for the eval harness.
 *
 * `toolRegistry` pulls in the ported editor, which is why this is bundled by
 * esbuild before the harness runs rather than imported by Node directly. The
 * flattening mirrors `videoToolSummaries` in aiService.ts: the harness must
 * measure the prompt the operator gets, not a hand-copied approximation of it.
 */
import { getToolManifest } from "../src/video/mcp/toolRegistry";

export interface VideoToolSummary {
  name: string;
  description: string;
  parameters: string[];
}

export function videoToolSummaries(): VideoToolSummary[] {
  return getToolManifest().map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const required = new Set(schema.required ?? []);
    return {
      name: tool.name,
      // `brief` where a tool states one: this list is the local lane's system
      // prompt, and the full `description` is written for an MCP client with
      // room for it. See `brief` in toolRegistry.ts.
      description: tool.brief ?? tool.description,
      parameters: Object.keys(schema.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`)),
    };
  });
}
