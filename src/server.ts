import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { STATE_KEY_NAMESPACES } from "./state-key.js";
import { CATEGORIES, type ToolResult, type Tools } from "./tools.js";

// Wraps a tool so a thrown error comes back as an error result instead of killing the call.
function reply(run: () => ToolResult) {
  try {
    const r = run();
    return { ...(r.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: r.text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
  }
}

export function createServer(tools: Tools, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "open-brain", version });

  server.registerTool(
    "brain_save",
    {
      title: "Save to Brain",
      description:
        "Save a decision, bug fix, pattern, or lesson to a local knowledge base. " +
        "Call this whenever you make a decision, fix a bug, learn something non-obvious, or the user corrects you. " +
        "Write the content for a future agent with zero context about this session. " +
        "Use state_key for current-value facts so a later save replaces the earlier value.",
      inputSchema: z.object({
        content: z
          .string()
          .describe(
            "The full note. Write for a future agent with zero context. " +
              "When it replaces an older note, start with SUPERSEDES <id> and that note is archived."
          ),
        title: z
          .string()
          .optional()
          .describe("Short title, max 60 chars. When omitted, the content's first line becomes the title"),
        category: z.enum(CATEGORIES).optional().describe("Category of the note (default: thought)"),
        project: z.string().optional().describe("Project name (e.g. web-app). Omit for a note that applies everywhere"),
        tags: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe("Tags: an array, or a comma-separated string"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Additional structured data"),
        state_key: z
          .string()
          .optional()
          .describe(
            "For a CURRENT-VALUE fact that will change later (a setting, a status, an owner), pass a key like config:theme. " +
              "Saving under the same key archives the previous value, so search returns only the current one. " +
              `Namespaces: ${STATE_KEY_NAMESPACES.join(", ")}. ` +
              "Omit it for anything that stays true once it happened: an event, a decision, a lesson."
          ),
      }),
    },
    async (args) => reply(() => tools.save(args))
  );

  server.registerTool(
    "brain_search",
    {
      title: "Search Brain",
      description:
        "Search the knowledge base by keyword. Matches exact words (with simple stemming), ranked by BM25, " +
        "with an exact-phrase match on top. It does not match by meaning, so use the words the note probably " +
        "contains: product, file, table, error-string and command names. Several guessed keywords in one query " +
        "work well, because any word can match and notes with more of them rank higher. " +
        "Use at session start to load context, and whenever a request may relate to earlier work.",
      inputSchema: z.object({
        query: z.string().describe("Keywords to look for. Concrete names beat a prose description."),
        project: z.string().optional().describe("Only this project"),
        category: z.string().optional().describe("Only this category"),
        limit: z.number().optional().default(10).describe("Max results (default 10)"),
      }),
    },
    async (args) => reply(() => tools.search(args))
  );

  server.registerTool(
    "brain_recent",
    {
      title: "Recent Notes",
      description:
        "List the newest notes, optionally filtered by project or category. Use at session start for quick context.",
      inputSchema: z.object({
        project: z.string().optional().describe("Only this project"),
        category: z.string().optional().describe("Only this category"),
        limit: z.number().optional().default(10).describe("How many to return (default 10)"),
      }),
    },
    async (args) => reply(() => tools.recent(args))
  );

  server.registerTool(
    "brain_stats",
    {
      title: "Brain Stats",
      description: "Counts by project and category, notes added this week, and how many are archived.",
      inputSchema: z.object({
        project: z.string().optional().describe("Only this project"),
      }),
    },
    async (args) => reply(() => tools.stats(args))
  );

  server.registerTool(
    "brain_update_project",
    {
      title: "Move Notes to Another Project",
      description:
        "Move every note from one project to another (or to no project). " +
        "Use dry_run to see how many would move first.",
      inputSchema: z.object({
        from_project: z.string().nullable().describe("Project to move from. null matches notes with no project."),
        to_project: z.string().nullable().describe("Project to move to. null clears the project."),
        dry_run: z.boolean().optional().default(false).describe("If true, only report how many notes would move."),
      }),
    },
    async (args) => reply(() => tools.updateProject(args))
  );

  server.registerTool(
    "brain_delete",
    {
      title: "Delete Note",
      description:
        "Delete one note by its id or a unique id prefix (8+ characters). No undo. " +
        "Refuses a prefix that matches more than one note. To replace a note instead, save the new one with SUPERSEDES <id>.",
      inputSchema: z.object({
        id: z.string().describe("Full id, or a prefix of at least 8 hex characters that matches one note."),
      }),
    },
    async (args) => reply(() => tools.delete(args))
  );

  return server;
}
