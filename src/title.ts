export const TITLE_MAX = 60;

// A note saved without a title shows as "Untitled" in every list and loses the extra
// weight a title gets in search. So brain_save fills one in from the first non-empty
// line of the content.
export function deriveTitle(content: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw
      .replace(/\*\*|`/g, "")
      .replace(/^[^\p{L}\p{N}"'(\[]+/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (line.length <= TITLE_MAX) return line;
    const cut = line.lastIndexOf(" ", TITLE_MAX);
    // A hard cut must not split an emoji's surrogate pair: half a pair is invalid Unicode.
    const end = /[\uD800-\uDBFF]/.test(line[TITLE_MAX - 1]) ? TITLE_MAX - 1 : TITLE_MAX;
    const title = cut >= TITLE_MAX / 2 ? line.slice(0, cut) : line.slice(0, end);
    return title.replace(/[\s,;:]+$/, "");
  }
  return null;
}
