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
  MAX_TOKENS: z.coerce.number().int().positive().default(2048),

  SYSTEM_PROMPT: z
    .string()
    .default(
      "You are a helpful AI assistant with access to tools. Use tools when they help answer the user accurately.",
    ),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(8),
  SESSION_TTL_MS: z.coerce.number().int().positive().default(3_600_000),

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
