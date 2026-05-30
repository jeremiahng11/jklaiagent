import type { Tool } from "./types.js";

const MAX_BYTES = 100_000; // cap response size to keep token usage sane
const TIMEOUT_MS = 10_000;

/**
 * Example tool: fetches a URL and returns its text body (truncated). Shows a
 * tool that does real I/O, validates input, and handles errors gracefully.
 */
export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch the contents of a public HTTP(S) URL and return its text body (truncated). Useful for reading web pages, APIs, or documents the user references.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The absolute http:// or https:// URL to fetch.",
      },
    },
    required: ["url"],
  },
  async handler(input, ctx) {
    const url = typeof input.url === "string" ? input.url.trim() : "";

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: "${url}" is not a valid URL.`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: only http and https URLs are supported (got ${parsed.protocol}).`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(parsed, {
        signal: controller.signal,
        headers: { "User-Agent": "jklaiagent/0.1 (+https://github.com/jeremiahng11/jklaiagent)" },
        redirect: "follow",
      });

      const contentType = res.headers.get("content-type") ?? "unknown";
      const raw = await res.text();
      const truncated = raw.length > MAX_BYTES;
      const body = truncated ? raw.slice(0, MAX_BYTES) : raw;

      return JSON.stringify({
        status: res.status,
        contentType,
        truncated,
        body,
      });
    } catch (err) {
      ctx.log.warn({ err, url }, "fetch_url failed");
      const message = err instanceof Error ? err.message : String(err);
      return `Error fetching ${url}: ${message}`;
    } finally {
      clearTimeout(timer);
    }
  },
};
