import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { buildUserContent } from "./content.js";
import {
  getHistory,
  saveHistory,
  clearSession,
  sessionCount,
  sweepExpiredSessions,
} from "./sessions.js";
import { tools } from "./tools/index.js";
import { chatPage } from "./ui.js";

const attachmentSchema = z.object({
  name: z.string().max(256).default("file"),
  mediaType: z.string().min(1).max(128),
  /** base64-encoded file bytes (no data: prefix). */
  data: z.string().min(1),
});

const chatBodySchema = z
  .object({
    message: z.string().default(""),
    sessionId: z.string().min(1).optional(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .refine(
    (d) => d.message.trim() !== "" || (d.attachments?.length ?? 0) > 0,
    { message: "provide a message and/or at least one attachment" },
  );

export function buildServer(): FastifyInstance {
  const app = Fastify({
    // Allow base64-encoded image/file uploads in the JSON body.
    bodyLimit: 30 * 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      ...(process.env.NODE_ENV !== "production"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
  });

  // --- Auth: require a bearer token on non-health routes when configured. ---
  app.addHook("onRequest", async (req, reply) => {
    if (!config.AGENT_API_KEY) return; // auth disabled
    // The chat page and health check are public; the page itself sends the
    // bearer token on its /chat calls.
    const path = req.url.split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/health")) return;

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token !== config.AGENT_API_KEY) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Browser chat UI.
  app.get("/", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(chatPage);
  });

  app.get("/health", async () => ({
    status: "ok",
    model: config.ANTHROPIC_MODEL,
    sessions: sessionCount(),
    tools: tools.map((t) => t.name),
  }));

  // --- Main agent endpoint. POST a message, get a reply. ---
  app.post("/chat", async (req, reply) => {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid request", details: parsed.error.flatten() });
    }

    const { message, attachments } = parsed.data;
    const sessionId = parsed.data.sessionId ?? randomUUID();
    const history = getHistory(sessionId);

    let userContent: string | Anthropic.ContentBlockParam[];
    try {
      userContent = buildUserContent(message, attachments ?? []);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "bad attachment";
      return reply.code(400).send({ error: "invalid_attachment", detail });
    }

    try {
      const result = await runAgent(history, userContent, req.log);
      saveHistory(sessionId, result.messages);
      return {
        sessionId,
        reply: result.reply,
        toolsUsed: result.toolsUsed,
      };
    } catch (err) {
      req.log.error({ err }, "agent run failed");
      const message = err instanceof Error ? err.message : "unknown error";
      return reply
        .code(502)
        .send({ error: "agent_failed", detail: message, sessionId });
    }
  });

  // --- Reset a conversation. ---
  app.delete("/chat/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const existed = clearSession(sessionId);
    return reply.code(existed ? 200 : 404).send({ sessionId, cleared: existed });
  });

  // Periodically evict idle sessions so memory doesn't grow unbounded.
  const sweepTimer = setInterval(() => {
    const removed = sweepExpiredSessions(Date.now());
    if (removed > 0) app.log.debug({ removed }, "swept idle sessions");
  }, 60_000);
  sweepTimer.unref();
  app.addHook("onClose", async () => clearInterval(sweepTimer));

  return app;
}
