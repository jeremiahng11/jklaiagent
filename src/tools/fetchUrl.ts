import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool } from "./types.js";

const MAX_BYTES = 100_000; // cap response size to keep token usage sane
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

/**
 * True for addresses that point back at the host or its private network:
 * loopback, link-local, RFC1918, carrier-grade NAT, and IPv6 equivalents.
 * Blocking these stops the tool from being used for SSRF against Meridian or
 * anything else on the internal network the agent is deployed in.
 */
function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    // IPv4-mapped (e.g. ::ffff:127.0.0.1)
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && mapped[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Resolves a hostname and rejects if any resolved address is private. */
async function assertPublicHost(hostname: string): Promise<void> {
  // Strip IPv6 brackets if present.
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`refusing to fetch a private/internal address (${host}).`);
    }
    return;
  }
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    throw new Error(`refusing to fetch internal host "${host}".`);
  }
  const records = await lookup(host, { all: true });
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(`"${host}" resolves to a private/internal address (${address}).`);
    }
  }
}

/**
 * Example tool: fetches a URL and returns its text body (truncated). Shows a
 * tool that does real I/O, validates input, follows redirects safely, and
 * handles errors gracefully.
 */
export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch the contents of a public HTTP(S) URL and return its text body (truncated). Useful for reading web pages, APIs, or documents the user references. Private/internal addresses are blocked.",
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
      // Follow redirects manually so every hop is re-validated — otherwise a
      // public URL could redirect us into the internal network.
      let current = parsed;
      let res: Response;
      for (let hop = 0; ; hop++) {
        await assertPublicHost(current.hostname);
        res = await fetch(current, {
          signal: controller.signal,
          headers: { "User-Agent": "jklaiagent/0.1 (+https://github.com/jeremiahng11/jklaiagent)" },
          redirect: "manual",
        });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        if (!location) break;
        if (hop >= MAX_REDIRECTS) {
          return `Error fetching ${url}: too many redirects (>${MAX_REDIRECTS}).`;
        }
        current = new URL(location, current);
        if (current.protocol !== "http:" && current.protocol !== "https:") {
          return `Error: redirect to unsupported protocol (${current.protocol}).`;
        }
      }

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
