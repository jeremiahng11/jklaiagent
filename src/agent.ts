import Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { toolDefs, executeTool } from "./tools/index.js";

// Single shared client pointed at Meridian's Anthropic-compatible endpoint.
const client = new Anthropic({
  baseURL: config.MERIDIAN_BASE_URL,
  apiKey: config.MERIDIAN_API_KEY,
});

export interface AgentResult {
  /** Final assistant text shown to the user. */
  reply: string;
  /** Full message history including this turn, to persist for the session. */
  messages: Anthropic.MessageParam[];
  /** Names of tools invoked during this turn (for logging/observability). */
  toolsUsed: string[];
}

function textFrom(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Runs one agentic turn: sends the conversation to Claude (via Meridian) and
 * keeps resolving tool calls until the model produces a final answer or the
 * iteration cap is hit.
 */
export async function runAgent(
  history: Anthropic.MessageParam[],
  userMessage: string,
  log: FastifyBaseLogger,
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];
  const toolsUsed: string[] = [];

  for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: config.MAX_TOKENS,
      system: config.SYSTEM_PROMPT,
      tools: toolDefs,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return { reply: textFrom(response.content), messages, toolsUsed };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        toolsUsed.push(tu.name);
        log.info({ tool: tu.name, input: tu.input }, "executing tool");
        const { output, isError } = await executeTool(tu.name, tu.input, { log });
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: output,
          is_error: isError,
        };
      }),
    );

    messages.push({ role: "user", content: toolResults });
  }

  // Hit the iteration cap without a final answer — return whatever text we have
  // plus a clear note, rather than looping forever.
  log.warn({ cap: config.MAX_TOOL_ITERATIONS }, "tool iteration cap reached");
  const last = messages[messages.length - 1];
  const partial =
    last && last.role === "assistant" && Array.isArray(last.content)
      ? textFrom(last.content as Anthropic.ContentBlock[])
      : "";
  return {
    reply:
      partial ||
      "I wasn't able to finish this request within the tool-call limit. Please try narrowing the request.",
    messages,
    toolsUsed,
  };
}
