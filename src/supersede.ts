// A save that starts "SUPERSEDES <id>" names the note it replaces, and brain_save archives
// that note in the same write. Only ids count, never similarity: two notes on different
// subjects can look alike, and archiving by likeness removes the wrong one. Only the ids
// listed right after the word are read, so "SUPERSEDES the X decision in <title> (<id>)",
// a partial replacement, archives nothing.

const ID = "[0-9a-fA-F][0-9a-fA-F-]{7,35}";
const SEP = "\\s*(?:,\\s*(?:and\\s+)?|&\\s*|and\\s+)";
const LEAD = new RegExp(`^\\s*SUPERSEDES:?\\s+(${ID}(?:${SEP}${ID})*)(?![0-9A-Za-z-])`);

export function startsWithSupersedes(content: string): boolean {
  return /^\s*SUPERSEDES\b/.test(content);
}

// The ids named right after SUPERSEDES: full ids or hex prefixes of 8 or more characters.
export function supersededRefs(content: string): string[] {
  const m = content.match(LEAD);
  if (!m) return [];
  const refs = m[1].match(new RegExp(ID, "g")) ?? [];
  return refs.map((r) => r.toLowerCase()).filter((r) => /^[0-9a-f]{8,32}$/.test(r.replace(/-/g, "")));
}

export type SupersedeStatus =
  | "archived"
  | "already_archived"
  | "other_project"
  | "ambiguous"
  | "not_found"
  | "invalid";

export interface SupersedeRow {
  ref: string;
  status: SupersedeStatus;
  target_id: string | null;
  target_title: string | null;
  target_project: string | null;
}

// One reply line per ref.
export function supersedeNotes(rows: SupersedeRow[]): string[] {
  return rows.map((r) => {
    const title = r.target_title || "untitled";
    switch (r.status) {
      case "archived":
        return `SUPERSEDES: archived "${title}" (${r.target_id})`;
      case "already_archived":
        return `note: SUPERSEDES ${r.ref} ("${title}") was already archived`;
      case "other_project":
        return `WARNING: SUPERSEDES ${r.ref} is in project "${r.target_project || "global"}", not this note's; not archived`;
      case "ambiguous":
        return `WARNING: SUPERSEDES ${r.ref} matches more than one note; nothing archived. Use the full id`;
      default:
        return `WARNING: SUPERSEDES ${r.ref}: no note has that id; nothing archived`;
    }
  });
}

export const NO_ID_NOTE =
  "note: SUPERSEDES names no id, so nothing was archived. Put the old note's id right after the word to archive it";
