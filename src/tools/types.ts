import type { FastifyBaseLogger } from "fastify";

/** JSON Schema describing a tool's input. Passed verbatim to Claude. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolContext {
  log: FastifyBaseLogger;
}

/**
 * A tool the agent can call. `handler` receives the raw input object Claude
 * produced (already validated against `inputSchema` by Claude, but treat it as
 * untrusted) and returns a string that is sent back as the tool result.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}
