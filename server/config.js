// Central env/config. Secrets come from the environment (.env locally, Coolify
// env vars in prod). Sensible dev defaults so it boots out of the box.
//
// The LLM brain talks to Claude through the Meridian proxy (Anthropic-compatible
// endpoint) — the same setup the standalone agent used. No model API keys live
// here; Meridian authenticates via your Claude Code subscription.

export const PORT = Number(process.env.PORT || 3000);
export const HOST = "0.0.0.0";

export const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-insecure-change-me-please-32+chars";
export const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
export const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin";
export const COOKIE_NAME = "mc_session";

export const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Meridian (Anthropic-compatible proxy in front of Claude) ---
export const MERIDIAN_BASE_URL = process.env.MERIDIAN_BASE_URL || "http://localhost:8080";
// Placeholder the Anthropic SDK requires; Meridian auths via your Claude session.
export const MERIDIAN_API_KEY = process.env.MERIDIAN_API_KEY || "meridian";

// Two model tiers, both served by Meridian:
//  - HEAVY: the quality-critical work — agents' deliverables, planning, synthesis.
//  - LIGHT: high-frequency, low-stakes orchestration — review, routing, memory
//    notes, the AUTO demo. Cheaper/faster.
export const HEAVY_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
export const LIGHT_MODEL = process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-4-5-20251001";
// AUTO demo is ALWAYS simulated — pure visual entertainment, never a real model
// call (so leaving AUTO on can't run up usage). Only tasks YOU assign use Claude.
export const DEMO_MODEL = null;

// Back-compat aliases — the rest of the server still imports these names; they
// now resolve to the Claude tiers above (heavy = "pro" path, light = "flash" path).
export const GEMINI_MODEL = HEAVY_MODEL;
export const GEMINI_FLASH_MODEL = LIGHT_MODEL;
export const GEMINI_DEMO_MODEL = DEMO_MODEL; // null → AUTO demo is simulated
export const GEMINI_FLASH_API_KEY = ""; // single Meridian endpoint — no separate key
export const GEMINI_DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD || 0);

// Force the believable no-LLM simulation (office still runs end-to-end). Default
// is live (talk to Meridian). Set SIMULATE=true to demo without any model calls.
export const SIMULATE = process.env.SIMULATE === "true";

export const TICK_MS = Number(process.env.TICK_MS || 1500);
// OFF by default: the office only works on tasks YOU assign. Flip on with the
// AUTO button (or AUTONOMOUS=true) for the self-running demo.
export const AUTONOMOUS_DEFAULT = process.env.AUTONOMOUS === "true";

export const IS_PROD = process.env.NODE_ENV === "production";

if (IS_PROD && (AUTH_PASSWORD === "admin" || SESSION_SECRET.startsWith("dev-"))) {
  console.warn(
    "[mission-control] WARNING: default AUTH_PASSWORD/SESSION_SECRET in production — set them in env."
  );
}
