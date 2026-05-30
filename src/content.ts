import type Anthropic from "@anthropic-ai/sdk";

/** Image formats Claude accepts as base64 image blocks. */
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Max decoded characters of a text file we inline into the prompt. */
const MAX_TEXT_CHARS = 100_000;

export interface Attachment {
  name: string;
  mediaType: string;
  /** base64-encoded bytes (no data: prefix). */
  data: string;
}

/**
 * Builds the user-turn content for Claude from a text message plus uploaded
 * attachments:
 *   - images        -> image blocks (vision)
 *   - PDFs          -> document blocks
 *   - text-like     -> decoded and inlined as a labelled text block
 *
 * Returns a plain string when there are no attachments (keeps simple turns
 * simple), otherwise an array of content blocks.
 */
export function buildUserContent(
  message: string,
  attachments: Attachment[],
): string | Anthropic.ContentBlockParam[] {
  if (attachments.length === 0) return message;

  const blocks: Anthropic.ContentBlockParam[] = [];
  if (message.trim() !== "") {
    blocks.push({ type: "text", text: message });
  }

  for (const att of attachments) {
    const mediaType = att.mediaType.toLowerCase();

    if (IMAGE_TYPES.has(mediaType)) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: att.data,
        },
      });
    } else if (mediaType === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: att.data },
      });
    } else {
      // Treat everything else as a text file: decode and inline it.
      const decoded = Buffer.from(att.data, "base64").toString("utf-8");
      const truncated = decoded.length > MAX_TEXT_CHARS;
      const body = truncated ? decoded.slice(0, MAX_TEXT_CHARS) : decoded;
      blocks.push({
        type: "text",
        text:
          `Attached file "${att.name}" (${mediaType || "text/plain"})` +
          (truncated ? " [truncated]" : "") +
          `:\n\n${body}`,
      });
    }
  }

  return blocks;
}
