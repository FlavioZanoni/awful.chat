import { MessageType, type Message } from "$lib/types/message";

/**
 * Extract displayable text for a message when it is quoted in a reply.
 *
 * Returns either the message text (trimmed to 160 chars) or a type-appropriate
 * placeholder like [image] or [file] when the message has no readable text.
 * Used when building reply snapshots and rendering quoted text so the preview
 * and sent result always agree on what appears in the quote.
 */
export function getQuotableText(msg: Message): string {
  // If content exists and is not a URL (from GIF picker), use it
  if (msg.content && !isUrlLike(msg.content)) {
    return trimContent(msg.content);
  }

  // Content is empty or is a URL. Check message type for appropriate placeholder.
  if (msg.type === MessageType.File && msg.meta?.files?.[0]) {
    // File attachment - use filename if available, else generic placeholder
    return `[${msg.meta.files[0].filename || "file"}]`;
  }

  // Default placeholder for image-only or empty messages (GIF picker sends URL content)
  return "[image]";
}

/**
 * Trim content to 160 characters with ellipsis if needed. Matches the snapshot
 * construction logic used when building reply snapshots on send.
 */
function trimContent(text: string): string {
  if (text.length <= 160) return text;
  return `${text.slice(0, 157)}...`;
}

/**
 * Detect whether a string is a URL. Used to identify GIF/image URLs from the
 * GIF picker, which sets the message content to a bare URL.
 */
function isUrlLike(text: string): boolean {
  return text.startsWith("http://") || text.startsWith("https://");
}
