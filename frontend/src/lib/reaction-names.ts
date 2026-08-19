/**
 * "Who reacted" tooltip text: "You" first when present, at most four names,
 * the rest folded into "and x others".
 */
export function formatReactorNames(
  names: string[],
  includesSelf: boolean
): string {
  const ordered = includesSelf ? ["You", ...names] : names;
  const shown = ordered.slice(0, 4);
  const rest = ordered.length - shown.length;
  return rest > 0
    ? `${shown.join(", ")} and ${rest} other${rest > 1 ? "s" : ""}`
    : shown.join(", ");
}
