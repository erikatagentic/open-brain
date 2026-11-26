#!/usr/bin/env node
// smoke.mjs: starts the built server over stdio with a throwaway data file, the way an MCP
// client would, and checks tools/list plus a brain_save and brain_search round trip.
//
//   npm run build && node scripts/smoke.mjs
//
// Exit 0 on success, 1 on any failure.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "open-brain-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  env: { ...process.env, OPEN_BRAIN_DB: join(dir, "brain.sqlite3"), OPEN_BRAIN_SOURCE: "smoke" },
  stderr: "pipe",
});
const client = new Client({ name: "open-brain-smoke", version: "0.0.0" });
const text = (r) => r.content.map((c) => c.text).join("\n");

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["brain_delete", "brain_recent", "brain_save", "brain_search", "brain_stats", "brain_update_project"]);
  console.log(`tools/list: ${names.join(", ")}`);

  const saved = await client.callTool({
    name: "brain_save",
    arguments: {
      title: "Smoke test note",
      content: "The smoke test saved this note about flaky sockets.",
      category: "learning",
      project: "smoke-demo",
      tags: "smoke, sockets",
    },
  });
  assert.ok(!saved.isError, text(saved));
  assert.match(text(saved), /^Saved: "Smoke test note"/);
  console.log(`brain_save: ${text(saved).split("\n")[0]}`);

  const found = await client.callTool({ name: "brain_search", arguments: { query: "flaky sockets" } });
  assert.ok(!found.isError, text(found));
  assert.match(text(found), /Smoke test note/);
  assert.match(text(found), /learning, smoke-demo, exact phrase/);
  console.log(`brain_search: ${text(found).split("\n")[0]}`);

  console.log("smoke: ok");
} catch (err) {
  console.error(`smoke: FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
