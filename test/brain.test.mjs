import assert from "node:assert/strict";
import test from "node:test";
import { brain } from "./helpers.mjs";

test("save then search finds the note", (t) => {
  const { tools, idOf } = brain(t);
  const saved = tools.save({
    title: "Widget cache fix",
    content: "The widget cache kept stale prices because the TTL was set in seconds, not minutes.",
    category: "bug",
    project: "demo-shop",
    tags: "cache, ttl",
  });
  assert.match(saved.text, /^Saved: "Widget cache fix"/);
  const id = idOf(saved.text);

  const found = tools.search({ query: "widget TTL" });
  assert.match(found.text, /Widget cache fix/);
  assert.match(found.text, new RegExp(`id: ${id}`));
  assert.match(found.text, /bug, demo-shop/);
});

test("search matches tags and stemmed words, and filters by project", (t) => {
  const { tools } = brain(t);
  tools.save({ title: "Deploy notes", content: "Use the blue pipeline.", project: "alpha-app", tags: ["kubernetes"] });
  tools.save({ title: "Other deploy", content: "Deploying from a laptop is fine here.", project: "beta-app" });

  assert.match(tools.search({ query: "kubernetes" }).text, /Deploy notes/);
  const stemmed = tools.search({ query: "deploying" }).text;
  assert.match(stemmed, /Deploy notes/);
  assert.match(stemmed, /Other deploy/);
  const filtered = tools.search({ query: "deploy", project: "beta-app" }).text;
  assert.match(filtered, /Other deploy/);
  assert.doesNotMatch(filtered, /Deploy notes/);
});

test("search bumps the retrieval count of what it returns", (t) => {
  const { tools, store, idOf } = brain(t);
  const id = idOf(tools.save({ content: "Retrieval counter note about lemons" }).text);
  tools.search({ query: "lemons" });
  tools.search({ query: "lemons" });
  const found = store.findById(id);
  assert.equal(found.status, "found");
  assert.equal(found.note.retrieval_count, 2);
  assert.ok(found.note.last_retrieved_at);
});

test("archived notes don't come back from search or recent", (t) => {
  const { tools, idOf } = brain(t);
  const oldId = idOf(tools.save({ title: "Parser choice v1", content: "We parse the feed with a regex parser.", project: "feed-reader" }).text);
  tools.save({ title: "Parser choice v2", content: `SUPERSEDES ${oldId}\nWe parse the feed with a proper XML parser.`, project: "feed-reader" });

  const found = tools.search({ query: "parser feed" }).text;
  assert.match(found, /Parser choice v2/);
  assert.doesNotMatch(found, /Parser choice v1/);
  const recent = tools.recent({}).text;
  assert.match(recent, /Parser choice v2/);
  assert.doesNotMatch(recent, /Parser choice v1/);
});

test("SUPERSEDES <prefix> archives the named note and reports it", (t) => {
  const { tools, store, idOf } = brain(t);
  const oldId = idOf(tools.save({ title: "Old rate limit", content: "The API allows 10 calls a second.", project: "api-client" }).text);
  const reply = tools.save({
    title: "New rate limit",
    content: `SUPERSEDES ${oldId.slice(0, 8)}: the API now allows 25 calls a second.`,
    project: "api-client",
  });
  assert.match(reply.text, new RegExp(`SUPERSEDES: archived "Old rate limit" \\(${oldId}\\)`));
  const old = store.findById(oldId);
  assert.equal(old.note.archived, true);
  assert.equal(old.note.superseded_by, idOf(reply.text));
});

test("SUPERSEDES leaves a note in another project alone, and an unknown id is reported", (t) => {
  const { tools, store, idOf } = brain(t);
  const otherId = idOf(tools.save({ content: "Note in another project", project: "garden-planner" }).text);
  const reply = tools.save({ content: `SUPERSEDES ${otherId} and 99999999`, project: "api-client" });
  assert.match(reply.text, /is in project "garden-planner", not this note's; not archived/);
  assert.match(reply.text, /SUPERSEDES 99999999: no note has that id/);
  assert.equal(store.findById(otherId).note.archived, false);

  const noId = tools.save({ content: "SUPERSEDES the old plan, see above" });
  assert.match(noId.text, /SUPERSEDES names no id/);
});

test("SUPERSEDES refuses an ambiguous prefix", (t) => {
  const ids = [
    "abcdef12-0000-4000-8000-000000000001",
    "abcdef12-0000-4000-8000-000000000002",
    "11111111-0000-4000-8000-000000000003",
  ];
  const { tools, store } = brain(t, { ids });
  tools.save({ content: "First twin" });
  tools.save({ content: "Second twin" });
  const reply = tools.save({ content: "SUPERSEDES abcdef12 both twins" });
  assert.match(reply.text, /matches more than one note; nothing archived/);
  assert.equal(store.findById(ids[0]).note.archived, false);
  assert.equal(store.findById(ids[1]).note.archived, false);
});

test("state_key archives the previous value under the same key", (t) => {
  const { tools, store, idOf } = brain(t);
  const first = tools.save({ title: "Theme is light", content: "The app theme is light.", state_key: "config:theme" });
  assert.match(first.text, /State key config:theme: first value/);
  const firstId = idOf(first.text);

  const second = tools.save({ title: "Theme is dark", content: "The app theme is dark.", state_key: "Config:Theme" });
  assert.match(second.text, new RegExp(`replaced 1 earlier value\\(s\\): ${firstId}`));
  assert.equal(store.findById(firstId).note.archived, true);

  const found = tools.search({ query: "app theme" }).text;
  assert.match(found, /Theme is dark/);
  assert.match(found, /state:config:theme/);
  assert.doesNotMatch(found, /Theme is light/);
});

test("an invalid state_key still saves the note, with a warning, and replaces nothing", (t) => {
  const { tools } = brain(t);
  tools.save({ content: "Owner is Sam", state_key: "person:owner" });
  const reply = tools.save({ content: "Owner is Kim", state_key: "nonsense" });
  assert.match(reply.text, /^Saved:/);
  assert.match(reply.text, /WARNING: saved without its state key/);
  const found = tools.search({ query: "owner" }).text;
  assert.match(found, /Owner is Sam/);
  assert.match(found, /Owner is Kim/);
});

test("the same title within 24 hours is refused, and allowed after", (t) => {
  const { tools, store, advance } = brain(t);
  const first = tools.save({ title: "Nightly report", content: "Run 1 went fine." });
  assert.match(first.text, /^Saved:/);

  advance(23);
  const dup = tools.save({ title: "Nightly report", content: "Run 2 went fine." });
  assert.match(dup.text, /^Duplicate-title skip: "Nightly report" already saved within 24h/);
  assert.equal(store.stats(undefined, "2000-01-01T00:00:00Z").total, 1);

  advance(2);
  const later = tools.save({ title: "Nightly report", content: "Run 3 went fine." });
  assert.match(later.text, /^Saved:/);
  assert.equal(store.stats(undefined, "2000-01-01T00:00:00Z").total, 2);
});

test("a valid state_key may reuse a title inside the 24-hour window", (t) => {
  const { tools } = brain(t);
  tools.save({ title: "Build status", content: "Build is red.", state_key: "status:build" });
  const reply = tools.save({ title: "Build status", content: "Build is green.", state_key: "status:build" });
  assert.match(reply.text, /replaced 1 earlier value/);
});

test("delete works by unique prefix and refuses an ambiguous one", (t) => {
  const ids = [
    "cafe0001-0000-4000-8000-000000000001",
    "cafe0001-0000-4000-8000-000000000002",
    "beef0002-0000-4000-8000-000000000003",
  ];
  const { tools, store } = brain(t, { ids });
  tools.save({ content: "Twin A" });
  tools.save({ content: "Twin B" });
  tools.save({ title: "Lonely note", content: "Only one of me" });

  const ambiguous = tools.delete({ id: "cafe0001" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /matches 2 notes. Nothing deleted/);
  assert.equal(store.stats(undefined, "2000-01-01T00:00:00Z").total, 3);

  const deleted = tools.delete({ id: "beef0002" });
  assert.match(deleted.text, /^Deleted: "Lonely note"/);
  assert.equal(store.findById(ids[2]).status, "not_found");
  assert.match(tools.search({ query: "lonely" }).text, /^No notes matched/);

  assert.equal(tools.delete({ id: "beef0002" }).isError, true);
  assert.equal(tools.delete({ id: "short" }).isError, true);
  assert.match(tools.delete({ id: ids[0] }).text, /^Deleted: "Twin A"/);
});

test("update_project moves notes, with a dry run first", (t) => {
  const { tools } = brain(t);
  tools.save({ content: "Alpha one", project: "old-name" });
  tools.save({ content: "Alpha two", project: "old-name" });
  tools.save({ content: "Unrelated", project: "keep-me" });

  const dry = tools.updateProject({ from_project: "old-name", to_project: "new-name", dry_run: true });
  assert.match(dry.text, /DRY RUN: would move 2 notes from "old-name" to "new-name"/);
  assert.match(tools.recent({ project: "old-name" }).text, /Alpha one/);

  const moved = tools.updateProject({ from_project: "old-name", to_project: "new-name" });
  assert.match(moved.text, /Moved 2 notes/);
  assert.equal(tools.recent({ project: "old-name" }).text, "No notes found.");
  const now = tools.recent({ project: "new-name" }).text;
  assert.match(now, /Alpha one/);
  assert.match(now, /Alpha two/);
  assert.match(tools.recent({ project: "keep-me" }).text, /Unrelated/);

  const cleared = tools.updateProject({ from_project: "new-name", to_project: null });
  assert.match(cleared.text, /Moved 2 notes: "new-name" to NULL/);
  assert.match(tools.updateProject({ from_project: "keep-me", to_project: "keep-me" }).text, /^No-op/);
});

test("stats counts live notes by category and project, and archived ones apart", (t) => {
  const { tools, advance, idOf } = brain(t);
  const oldId = idOf(tools.save({ content: "Old bug note", category: "bug", project: "web-app" }).text);
  advance(24 * 10);
  tools.save({ content: `SUPERSEDES ${oldId} new bug note`, category: "bug", project: "web-app" });
  tools.save({ content: "A decision", category: "decision", project: "web-app" });
  tools.save({ content: "A global lesson", category: "learning" });

  const all = tools.stats({}).text;
  assert.match(all, /Total notes: 3/);
  assert.match(all, /Added this week: 3/);
  assert.match(all, /Archived \(replaced or superseded\): 1/);
  assert.match(all, /- bug: 1/);
  assert.match(all, /- decision: 1/);
  assert.match(all, /- learning: 1/);
  assert.match(all, /- web-app: 2/);
  assert.match(all, /- global: 1/);

  const one = tools.stats({ project: "web-app" }).text;
  assert.match(one, /## Brain Stats \(web-app\)/);
  assert.match(one, /Total notes: 2/);
  assert.doesNotMatch(one, /By Project/);
});

test("search puts an exact phrase match above a scattered one", (t) => {
  const { tools } = brain(t);
  // The scattered note has every word, more often, and is newer, so plain BM25 alone could favour it.
  tools.save({ title: "Exact", content: "The build failed with connection reset by peer during upload." });
  tools.save({
    title: "Scattered",
    content: "Reset the peer list. The connection pool was slow. A peer dropped by the router. Reset again, connection fine, peer fine.",
  });
  const text = tools.search({ query: "connection reset by peer" }).text;
  const exact = text.indexOf("**Exact**");
  const scattered = text.indexOf("**Scattered**");
  assert.ok(exact >= 0 && scattered >= 0, text);
  assert.ok(exact < scattered, text);
  assert.match(text, /\*\*Exact\*\* \(thought, global, exact phrase\)/);
  assert.match(text, /\*\*Scattered\*\* \(thought, global, keyword match\)/);
});

test("a query with no words, or no match, says so plainly", (t) => {
  const { tools } = brain(t);
  tools.save({ content: "Something saved" });
  assert.match(tools.search({ query: "!!! ???" }).text, /^No notes matched/);
  assert.match(tools.search({ query: "zebra" }).text, /words, not meaning/);
});

test("project names are normalized and the source setting is stored", (t) => {
  const { tools, store, idOf } = brain(t);
  const id = idOf(tools.save({ content: "Mixed case project", project: "  Web-App " }).text);
  const globalId = idOf(tools.save({ content: "Global project", project: "global" }).text);
  assert.equal(store.findById(id).note.project, "web-app");
  assert.equal(store.findById(id).note.source, "test");
  assert.equal(store.findById(globalId).note.project, null);
});

test("search with project global returns only notes with no project", (t) => {
  const { tools } = brain(t);
  tools.save({ title: "Global marmalade note", content: "The marmalade recipe uses bitter oranges." });
  tools.save({ title: "Alpha marmalade note", content: "The marmalade jar label is blue.", project: "alpha-app" });

  const global = tools.search({ query: "marmalade", project: "global" }).text;
  assert.match(global, /Global marmalade note/);
  assert.doesNotMatch(global, /Alpha marmalade note/);
  const spaced = tools.search({ query: "marmalade", project: " Global " }).text;
  assert.match(spaced, /Global marmalade note/);
  assert.doesNotMatch(spaced, /Alpha marmalade note/);
  const all = tools.search({ query: "marmalade" }).text;
  assert.match(all, /Global marmalade note/);
  assert.match(all, /Alpha marmalade note/);
  const named = tools.search({ query: "marmalade", project: "alpha-app" }).text;
  assert.match(named, /Alpha marmalade note/);
  assert.doesNotMatch(named, /Global marmalade note/);
});

test("recent with project global returns only notes with no project", (t) => {
  const { tools } = brain(t);
  tools.save({ title: "Global marmalade note", content: "The marmalade recipe uses bitter oranges." });
  tools.save({ title: "Alpha marmalade note", content: "The marmalade jar label is blue.", project: "alpha-app" });

  const global = tools.recent({ project: "global" }).text;
  assert.match(global, /Global marmalade note/);
  assert.doesNotMatch(global, /Alpha marmalade note/);
  const all = tools.recent({}).text;
  assert.match(all, /Global marmalade note/);
  assert.match(all, /Alpha marmalade note/);
  const named = tools.recent({ project: "alpha-app" }).text;
  assert.match(named, /Alpha marmalade note/);
  assert.doesNotMatch(named, /Global marmalade note/);
});

test("stats with project global counts only notes with no project", (t) => {
  const { tools } = brain(t);
  tools.save({ title: "Global marmalade note", content: "The marmalade recipe uses bitter oranges." });
  tools.save({ title: "Alpha marmalade note", content: "The marmalade jar label is blue.", project: "alpha-app" });

  const global = tools.stats({ project: "global" }).text;
  assert.match(global, /^## Brain Stats \(global\)/);
  assert.match(global, /Total notes: 1\n/);
  assert.doesNotMatch(global, /By Project/);
});
