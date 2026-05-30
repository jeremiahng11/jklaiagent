import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

interface Session {
  messages: Anthropic.MessageParam[];
  lastAccess: number;
}

/**
 * Simple in-memory conversation store keyed by session id.
 *
 * NOTE: this is process-local and cleared on restart. For multi-instance or
 * durable history, swap this module for SQLite/Redis — the public functions
 * (get/save/clear) are all the rest of the app depends on.
 */
const sessions = new Map<string, Session>();

export function getHistory(sessionId: string): Anthropic.MessageParam[] {
  const s = sessions.get(sessionId);
  if (!s) return [];
  s.lastAccess = Date.now();
  return s.messages;
}

export function saveHistory(
  sessionId: string,
  messages: Anthropic.MessageParam[],
): void {
  sessions.set(sessionId, { messages, lastAccess: Date.now() });
}

export function clearSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function sessionCount(): number {
  return sessions.size;
}

/** Evicts sessions idle longer than SESSION_TTL_MS. Call on an interval. */
export function sweepExpiredSessions(now: number): number {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastAccess > config.SESSION_TTL_MS) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}
