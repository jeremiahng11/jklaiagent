import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Anthropic.MessageParam[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** One display turn derived from the raw Claude message history. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  images: string[]; // data URLs, reconstructed from stored base64
  files: string[]; // attachment labels
  tools: string[]; // tool names the assistant invoked
}

const dir = config.DATA_DIR;
const conversations = new Map<string, Conversation>();

function fileFor(id: string): string {
  return path.join(dir, `conv-${id}.json`);
}

/** Loads all persisted conversations into memory. Call once at startup. */
export async function initStore(): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  for (const f of entries) {
    if (!f.startsWith("conv-") || !f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      const conv = JSON.parse(raw) as Conversation;
      if (conv?.id && Array.isArray(conv.messages)) conversations.set(conv.id, conv);
    } catch {
      // skip unreadable/corrupt files rather than crashing on boot
    }
  }
  return conversations.size;
}

async function persist(conv: Conversation): Promise<void> {
  const tmp = fileFor(conv.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(conv));
  await fs.rename(tmp, fileFor(conv.id)); // atomic-ish write
}

export function listConversations(): ConversationMeta[] {
  return [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    }));
}

export function getConversation(id: string): Conversation | null {
  return conversations.get(id) ?? null;
}

export function newId(): string {
  return randomUUID();
}

/** Upserts a conversation's messages, bumps updatedAt, and persists to disk. */
export async function saveConversation(
  id: string,
  messages: Anthropic.MessageParam[],
  now: number,
  title?: string,
): Promise<Conversation> {
  let conv = conversations.get(id);
  if (!conv) {
    conv = { id, title: title ?? "New chat", createdAt: now, updatedAt: now, messages };
    conversations.set(id, conv);
  } else {
    conv.messages = messages;
    // Only set the title automatically while it's still the placeholder.
    if (title && (conv.title === "New chat" || conv.title.trim() === "")) {
      conv.title = title;
    }
  }
  conv.updatedAt = now;
  await persist(conv);
  return conv;
}

export async function renameConversation(
  id: string,
  title: string,
  now: number,
): Promise<Conversation | null> {
  const conv = conversations.get(id);
  if (!conv) return null;
  conv.title = title;
  conv.updatedAt = now;
  await persist(conv);
  return conv;
}

export async function deleteConversation(id: string): Promise<boolean> {
  const existed = conversations.delete(id);
  if (existed) {
    try {
      await fs.unlink(fileFor(id));
    } catch {
      // already gone — fine
    }
  }
  return existed;
}

export function conversationCount(): number {
  return conversations.size;
}

/**
 * Derives a display transcript from raw Claude messages: user text, inlined
 * file labels, reconstructed image thumbnails, assistant text, and tool usage.
 * Pure tool-plumbing turns (tool_result user messages) are dropped.
 */
export function messagesToTranscript(
  messages: Anthropic.MessageParam[],
): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const turn: TranscriptTurn = { role: "user", text: "", images: [], files: [], tools: [] };
      if (typeof m.content === "string") {
        turn.text = m.content;
      } else {
        for (const b of m.content) {
          if (b.type === "text") {
            const fm = /^Attached file "([^"]+)"/.exec(b.text);
            if (fm && fm[1]) turn.files.push(fm[1]);
            else turn.text += (turn.text ? "\n" : "") + b.text;
          } else if (b.type === "image" && b.source.type === "base64") {
            turn.images.push(`data:${b.source.media_type};base64,${b.source.data}`);
          } else if (b.type === "document") {
            turn.files.push("PDF document");
          }
        }
      }
      if (turn.text || turn.images.length || turn.files.length) out.push(turn);
    } else if (m.role === "assistant") {
      const turn: TranscriptTurn = { role: "assistant", text: "", images: [], files: [], tools: [] };
      const content = Array.isArray(m.content)
        ? m.content
        : [{ type: "text" as const, text: String(m.content) }];
      for (const b of content) {
        if (b.type === "text") turn.text += (turn.text ? "\n" : "") + b.text;
        else if (b.type === "tool_use") turn.tools.push(b.name);
      }
      if (turn.text || turn.tools.length) out.push(turn);
    }
  }

  return out;
}
