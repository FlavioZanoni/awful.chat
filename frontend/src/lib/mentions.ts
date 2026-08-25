/**
 * Mention token handling for @-mentions in chat.
 *
 * Wire format: mentions live inside msg.content as tokens `@[<did>]`, e.g.
 * `@[did:key:z6Mk...]`. Content is covered by message signature, so mentions
 * are tamper-proof.
 */

/**
 * Replace all recorded @Name mentions with @[did] tokens in content.
 * Processes names in longest-first order to avoid prefix collisions.
 * Unrecorded @something text is left untouched.
 *
 * @param content The message content with human-readable names
 * @param nameToDidMap Map from display names to DIDs
 * @returns Content with @Name replaced by @[did] tokens
 */
export function serialize(
  content: string,
  nameToDidMap: Map<string, string>
): string {
  // Sort by name length descending to handle prefix collisions
  // e.g., if both "Ana" and "Anna" are mentioned, replace "Anna" first
  const entries = Array.from(nameToDidMap.entries()).sort(
    (a, b) => b[0].length - a[0].length
  );

  let result = content;
  for (const [name, did] of entries) {
    // Match @Name (with word boundary to avoid partial matches)
    // Use case-sensitive replacement since names are exact
    const regex = new RegExp(`@${escapeRegex(name)}(?![\\w-])`, "g");
    result = result.replace(regex, `@[${did}]`);
  }

  return result;
}

/**
 * Convert @[did] tokens in content to human-readable @Name mentions.
 * Resolves current display names at render time for rename-proof display.
 *
 * @param content The message content with @[did] tokens
 * @param resolveName Function to resolve a DID to its display name
 * @returns Content with @[did] tokens replaced by mention chips (as HTML)
 */
export function humanize(
  content: string,
  resolveName: (did: string) => string
): string {
  // Match @[did] tokens
  // Allow any characters inside the brackets that are valid in a DID
  return content.replace(/@\[([^\[\]]+)\]/g, (match, did) => {
    // Names are PEER-CONTROLLED and this string ends up inside {@html}:
    // escaping here is what stands between a nickname like
    // "<img onerror=...>" and script execution in every viewer.
    const name = escapeHtml(resolveName(did));
    return `<span class="font-medium text-primary">@${name}</span>`;
  });
}

/**
 * Convert @[did] tokens in content to human-readable @Name mentions as plain text.
 * Used for previews and notifications where HTML is not appropriate.
 * Resolves current display names at render time for rename-proof display.
 *
 * @param content The message content with @[did] tokens
 * @param resolveName Function to resolve a DID to its display name
 * @returns Content with @[did] tokens replaced by plain text @Name
 */
export function humanizeMentions(
  content: string,
  resolveName: (did: string) => string
): string {
  // Match @[did] tokens
  return content.replace(/@\[([^\[\]]+)\]/g, (match, did) => {
    const name = resolveName(did);
    return `@${name}`;
  });
}

/**
 * Check if content mentions the given DID(s).
 * Compares against both DID forms for compatibility.
 *
 * @param content The message content
 * @param selfDids One or more DIDs to check against (typically identity did + transport selfId)
 * @returns true if any of the selfDids are mentioned in content
 */
export function mentionsMe(content: string, selfDids: string[]): boolean {
  // Match @[did] tokens
  const mentionedDids = new Set<string>();
  const regex = /@\[([^\[\]]+)\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    mentionedDids.add(match[1]);
  }

  // Check if any of our DIDs are mentioned
  return selfDids.some((did) => mentionedDids.has(did));
}

/**
 * Escape special regex characters in a string.
 * Used to safely include user-provided names in regex patterns.
 *
 * @param str The string to escape
 * @returns The escaped string safe for use in regex
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
