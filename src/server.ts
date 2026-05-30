import type Anthropic from "@anthropic-ai/sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { buildUserContent, type Attachment } from "./content.js";
import {
  newId,
  getConversation,
  saveConversation,
  renameConversation,
  deleteConversation,
  listConversations,
  conversationCount,
  messagesToTranscript,
} from "./store.js";
import { tools } from "./tools/index.js";
import { chatPage } from "./ui.js";

/** A conversation title from the first user input. */
function deriveTitle(message: string, attachments: Attachment[]): string {
  const t = message.trim();
  if (t) return t.slice(0, 60);
  if (attachments[0]?.name) return attachments[0].name;
  return "New chat";
}

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
    if (
      req.method === "GET" &&
      (path === "/" || path === "/health" || path === "/diag")
    ) {
      return;
    }

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
    meridianBaseUrl: config.MERIDIAN_BASE_URL,
    sessions: conversationCount(),
    tools: tools.map((t) => t.name),
  }));

  // --- Connectivity diagnostics: can THIS container reach Meridian? ---
  // Any HTTP response (even 404) proves the network hop works; only a thrown
  // error means the agent can't open a connection to MERIDIAN_BASE_URL.
  app.get("/diag", async () => {
    const target = config.MERIDIAN_BASE_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(target, { signal: controller.signal });
      return {
        meridianBaseUrl: target,
        reachable: true,
        status: res.status,
        hint: "Network hop works. If chat still fails, check MERIDIAN_API_KEY / model / Meridian logs.",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        meridianBaseUrl: target,
        reachable: false,
        error: message,
        hint: "Container cannot open a connection. Likely: Meridian bound to 127.0.0.1 (set it to 0.0.0.0), wrong host/port, env not applied (redeploy), or a host firewall.",
      };
    } finally {
      clearTimeout(timer);
    }
  });

  // --- Main agent endpoint. POST a message, get a reply. ---
  app.post("/chat", async (req, reply) => {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid request", details: parsed.error.flatten() });
    }

    const { message, attachments = [] } = parsed.data;
    const existing = parsed.data.sessionId
      ? getConversation(parsed.data.sessionId)
      : null;
    const sessionId = existing?.id ?? parsed.data.sessionId ?? newId();
    const history = existing?.messages ?? [];

    let userContent: string | Anthropic.ContentBlockParam[];
    try {
      userContent = buildUserContent(message, attachments);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "bad attachment";
      return reply.code(400).send({ error: "invalid_attachment", detail });
    }

    try {
      const result = await runAgent(history, userContent, req.log);
      const conv = await saveConversation(
        sessionId,
        result.messages,
        Date.now(),
        deriveTitle(message, attachments),
      );
      return {
        sessionId,
        title: conv.title,
        reply: result.reply,
        toolsUsed: result.toolsUsed,
      };
    } catch (err) {
      req.log.error({ err }, "agent run failed");
      const detail = err instanceof Error ? err.message : "unknown error";
      return reply.code(502).send({ error: "agent_failed", detail, sessionId });
    }
  });

  // --- Conversation history management. ---
  app.get("/sessions", async () => ({ sessions: listConversations() }));

  app.get("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = getConversation(id);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    return {
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      transcript: messagesToTranscript(conv.messages),
    };
  });

  app.patch("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().min(1).max(120) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid title" });
    const conv = await renameConversation(id, body.data.title, Date.now());
    if (!conv) return reply.code(404).send({ error: "not_found" });
    return { id: conv.id, title: conv.title };
  });

  app.delete("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existed = await deleteConversation(id);
    return reply.code(existed ? 200 : 404).send({ id, deleted: existed });
  });

  return app;
}
