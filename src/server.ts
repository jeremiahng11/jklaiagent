import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import {
  getHistory,
  saveHistory,
  clearSession,
  sessionCount,
  sweepExpiredSessions,
} from "./sessions.js";
import { tools } from "./tools/index.js";

const chatBodySchema = z.object({
  message: z.string().min(1, "message must not be empty"),
  sessionId: z.string().min(1).optional(),
});

export function buildServer(): FastifyInstance {
  const app = Fastify({
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
    if (req.method === "GET" && req.url === "/health") return;

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token !== config.AGENT_API_KEY) {
      return reply.code(401).send({ error: "unauthorized" });
    }
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

    const { message } = parsed.data;
    const sessionId = parsed.data.sessionId ?? randomUUID();
    const history = getHistory(sessionId);

    try {
      const result = await runAgent(history, message, req.log);
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
