import type { Tool } from "./types.js";

/**
 * Example tool: returns the current date/time. Demonstrates a zero-dependency,
 * no-argument tool.
 */
export const getTimeTool: Tool = {
  name: "get_current_time",
  description:
    "Get the current date and time. Use this whenever the user asks about the current time, today's date, or anything time-relative.",
  inputSchema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "Optional IANA timezone name (e.g. 'Asia/Singapore', 'UTC'). Defaults to the server timezone.",
      },
    },
  },
  async handler(input) {
    const timezone =
      typeof input.timezone === "string" && input.timezone.trim() !== ""
        ? input.timezone
        : undefined;

    const now = new Date();
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: timezone,
      }).format(now);
      return JSON.stringify({
        iso: now.toISOString(),
        formatted,
        timezone: timezone ?? "server-local",
      });
    } catch {
      // Invalid timezone string — fall back to ISO/UTC rather than throwing.
      return JSON.stringify({
        iso: now.toISOString(),
        formatted: now.toUTCString(),
        timezone: "UTC",
        note: `Unknown timezone "${timezone}", returned UTC instead.`,
      });
    }
  },
};
