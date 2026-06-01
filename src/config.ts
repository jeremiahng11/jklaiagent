import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  MERIDIAN_BASE_URL: z.string().url().default("http://localhost:8080"),
  MERIDIAN_API_KEY: z.string().min(1).default("meridian"),

  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-6"),
  // Generous default so full HTML pages / SVG logos aren't truncated mid-output.
  MAX_TOKENS: z.coerce.number().int().positive().default(8192),

  SYSTEM_PROMPT: z
    .string()
    .default(
      [
        "You are a capable creative and engineering assistant with access to tools. Use tools when they help you answer accurately.",
        "",
        "This app renders your output in a live preview pane, so prefer producing real, self-contained artifacts the user can see, copy, and download:",
        "- Invoices, documents, reports, letters, web pages, and mobile-screen mockups: output ONE complete, self-contained HTML file in a single ```html code block — inline CSS, no external dependencies, print-friendly. For mobile mockups, size the layout for a phone (e.g. a 390x844 frame).",
        "- Logos, icons, and illustrations: output a single self-contained ```svg code block with a clean vector and a sensible color palette.",
        "- App / feature development: provide complete, runnable code, one file per code block, and name the file on the line above each block.",
        "",
        "Briefly ask for any essential missing detail (brand name, recipient, line items, etc.) before generating, but don't over-question — make reasonable assumptions and state them. Keep prose concise; let the artifact be the main deliverable.",
      ].join("\n"),
    ),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(8),

  /** Directory where conversations are persisted. Mount a volume here. */
  DATA_DIR: z.string().min(1).default("./data"),

  AGENT_API_KEY: z
    .string()
    .transform((v) => (v.trim() === "" ? undefined : v))
    .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast with a readable message rather than crashing deep in a request.
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
