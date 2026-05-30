import type Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolContext } from "./types.js";
import { getTimeTool } from "./getTime.js";
import { fetchUrlTool } from "./fetchUrl.js";

/**
 * Register tools here. To add a new capability, create a file in this folder
 * exporting a `Tool`, then add it to this array — nothing else needs to change.
 */
export const tools: Tool[] = [getTimeTool, fetchUrlTool];

const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** Tool definitions in the shape the Anthropic SDK expects. */
export const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
}));

export interface ToolExecution {
  output: string;
  isError: boolean;
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const tool = toolsByName.get(name);
  if (!tool) {
    return { output: `Error: unknown tool "${name}".`, isError: true };
  }
  const args =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  try {
    const output = await tool.handler(args, ctx);
    return { output, isError: false };
  } catch (err) {
    ctx.log.error({ err, tool: name }, "tool handler threw");
    const message = err instanceof Error ? err.message : String(err);
    return { output: `Error running tool "${name}": ${message}`, isError: true };
  }
}
