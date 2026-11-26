import type { Note, Store } from "./store.js";
import { validateStateKey } from "./state-key.js";
import { NO_ID_NOTE, startsWithSupersedes, supersededRefs, supersedeNotes } from "./supersede.js";
import { deriveTitle } from "./title.js";

export const CATEGORIES = [
  "decision",
  "bug",
  "pattern",
  "learning",
  "context",
  "thought",
  "idea",
  "reference",
] as const;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolOptions {
  // Written to every saved note's source field. Set it per client, e.g. "claude-code".
  source?: string;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Project names are trimmed and lowercased so "Web-App" and "web-app" are one project.
// Empty or "global" means no project (a note that applies everywhere).
export function normalizeProject(raw: string | null | undefined): string | null {
  const p = (raw ?? "").trim().toLowerCase();
  return !p || p === "global" ? null : p;
}

// A read filter: no project given (or blank) = undefined, any project; "global" = null,
// only notes with no project; anything else = that project.
function projectFilter(raw: string | undefined): string | null | undefined {
  return raw?.trim() ? normalizeProject(raw) : undefined;
}

function clampLimit(limit: number | undefined, fallback = 10): number {
  const n = Math.floor(Number(limit ?? fallback));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : fallback;
}

function preview(content: string, max: number): string {
  return content.length > max ? `${content.slice(0, max)}...` : content;
}

const label = (p: string | null) => (p === null ? "NULL" : `"${p}"`);

export function createTools(store: Store, opts: ToolOptions = {}) {
  const source = opts.source || "mcp";
  const now = opts.now ?? (() => new Date());

  return {
    save(args: {
      content: string;
      title?: string;
      category?: string;
      project?: string;
      tags?: string[] | string;
      metadata?: Record<string, unknown>;
      state_key?: string;
    }): ToolResult {
      const { content, title, category, project, tags, metadata, state_key } = args;
      let stateKey: string | undefined;
      let stateNote: string | null = null;
      const rawStateKey = state_key?.trim();
      if (rawStateKey) {
        const validated = validateStateKey(rawStateKey);
        if (validated.ok) stateKey = validated.key;
        else stateNote = `WARNING: saved without its state key (${validated.error})`;
      }

      // Tags may arrive as an array or a comma-separated string.
      const tagsArr = Array.isArray(tags)
        ? tags.map((s) => s.trim()).filter(Boolean)
        : tags
          ? tags.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

      // Same title within 24 hours = skip, so a loop or a retry can't pile up copies.
      // Only a valid state key may replace an earlier value inside that window.
      if (title && !stateKey) {
        const since = new Date(now().getTime() - DAY_MS).toISOString();
        const dup = store.findTitleSince(title, since);
        if (dup) {
          return {
            text:
              `Duplicate-title skip: "${title}" already saved within 24h (${dup.id}). Nothing written. ` +
              "Use a distinct title if this is new information." +
              (stateNote ? `\n${stateNote}` : ""),
          };
        }
      }

      const refs = supersededRefs(content);
      const { note, replaced, supersede } = store.save(
        {
          title: title || deriveTitle(content),
          content,
          category: category || "thought",
          project: normalizeProject(project),
          source,
          tags: tagsArr,
          metadata: metadata || {},
        },
        { stateKey, supersedes: refs }
      );

      if (stateKey) {
        stateNote =
          replaced.length > 0
            ? `State key ${stateKey}: replaced ${replaced.length} earlier value(s): ${replaced.join(", ")}`
            : `State key ${stateKey}: first value`;
      }
      let supersedeNote: string | null = null;
      if (refs.length > 0) supersedeNote = supersedeNotes(supersede).join("\n");
      else if (startsWithSupersedes(content)) supersedeNote = NO_ID_NOTE;

      return {
        text:
          `Saved: "${note.title || "untitled"}" (${note.id}) at ${note.created_at}` +
          (stateNote ? `\n${stateNote}` : "") +
          (supersedeNote ? `\n${supersedeNote}` : ""),
      };
    },

    search(args: { query: string; project?: string; category?: string; limit?: number }): ToolResult {
      const hits = store.search(
        args.query,
        { project: projectFilter(args.project), category: args.category || null },
        clampLimit(args.limit)
      );
      if (hits.length === 0) {
        return {
          text:
            `No notes matched those words${args.category ? ` in category "${args.category}"` : ""}. ` +
            "Search matches words, not meaning, so try other words the note might use.",
        };
      }
      store.bumpRetrieval(hits.map((h) => h.note.id));
      const text = hits
        .map(
          ({ note: t, phrase }, i) =>
            `${i + 1}. **${t.title || "Untitled"}** (${t.category}${t.state_key ? `, state:${t.state_key}` : ""}, ${t.project || "global"}, ${phrase ? "exact phrase" : "keyword match"})\n` +
            `   id: ${t.id}\n` +
            `   ${preview(t.content, 300)}\n` +
            `   Tags: ${t.tags.join(", ") || "none"} | ${t.created_at.slice(0, 10)}`
        )
        .join("\n\n");
      return { text };
    },

    recent(args: { project?: string; category?: string; limit?: number }): ToolResult {
      const notes = store.recent(
        { project: projectFilter(args.project), category: args.category || null },
        clampLimit(args.limit)
      );
      if (notes.length === 0) return { text: "No notes found." };
      store.bumpRetrieval(notes.map((n) => n.id));
      const text = notes
        .map(
          (t: Note, i) =>
            `${i + 1}. [${t.category}${t.state_key ? `, state:${t.state_key}` : ""}] **${t.title || "Untitled"}** (${t.project || "global"})\n` +
            `   id: ${t.id}\n` +
            `   ${preview(t.content, 200)}\n` +
            `   ${t.created_at.slice(0, 10)}`
        )
        .join("\n\n");
      return { text };
    },

    stats(args: { project?: string }): ToolResult {
      const project = projectFilter(args.project);
      const weekAgo = new Date(now().getTime() - 7 * DAY_MS).toISOString();
      const s = store.stats(project, weekAgo);
      let out = `## Brain Stats${project === undefined ? "" : ` (${project ?? "global"})`}\n\n`;
      out += `Total notes: ${s.total}\n`;
      out += `Added this week: ${s.addedSince}\n`;
      out += `Archived (replaced or superseded): ${s.archived}\n\n`;
      if (s.byCategory.length) {
        out += "### By Category\n";
        for (const r of s.byCategory) out += `- ${r.category}: ${r.count}\n`;
        out += "\n";
      }
      if (s.byProject.length) {
        out += "### By Project\n";
        for (const r of s.byProject) out += `- ${r.project || "global"}: ${r.count}\n`;
      }
      return { text: out.trimEnd() };
    },

    updateProject(args: { from_project: string | null; to_project: string | null; dry_run?: boolean }): ToolResult {
      const from = args.from_project === null ? null : normalizeProject(args.from_project);
      const to = args.to_project === null ? null : normalizeProject(args.to_project);
      if (from === to) return { text: `No-op: from_project and to_project are the same (${label(from)}).` };
      const count = store.countProject(from);
      if (args.dry_run) {
        return {
          text: `DRY RUN: would move ${count} notes from ${label(from)} to ${label(to)}. Pass dry_run=false to do it.`,
        };
      }
      if (count === 0) return { text: `No notes in ${label(from)}. Nothing to update.` };
      const moved = store.renameProject(from, to);
      return { text: `Moved ${moved} notes: ${label(from)} to ${label(to)}.` };
    },

    delete(args: { id: string }): ToolResult {
      const found = store.findById(args.id);
      switch (found.status) {
        case "invalid":
          return { isError: true, text: `"${args.id}" is not an id. Pass a full id or a prefix of at least 8 hex characters.` };
        case "not_found":
          return { isError: true, text: `No note has an id starting with "${args.id}". Nothing deleted.` };
        case "ambiguous":
          return {
            isError: true,
            text: `"${args.id}" matches ${found.count} notes. Nothing deleted. Use a longer prefix or the full id.`,
          };
      }
      const n = found.note;
      store.delete(n.id);
      return { text: `Deleted: "${n.title || "(untitled)"}" (${n.category}, ${n.project || "no project"}, ${n.id})` };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
