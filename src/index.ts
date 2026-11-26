#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { SqliteStore } from "./store.js";
import { createTools } from "./tools.js";

// Settings, all optional:
//   OPEN_BRAIN_DB      path of the SQLite file (default ~/.open-brain/brain.sqlite3)
//   OPEN_BRAIN_SOURCE  written to each note's source field (default "mcp")
const dbPath = process.env.OPEN_BRAIN_DB || join(homedir(), ".open-brain", "brain.sqlite3");
const source = process.env.OPEN_BRAIN_SOURCE || "mcp";

async function main() {
  const store = new SqliteStore({ path: dbPath });
  const server = createServer(createTools(store, { source }));
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so status goes to stderr.
  console.error(`open-brain: running on stdio, data file ${dbPath}`);
}

main().catch((err) => {
  console.error("open-brain: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
