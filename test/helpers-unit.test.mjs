import assert from "node:assert/strict";
import test from "node:test";
import { validateStateKey } from "../dist/state-key.js";
import { startsWithSupersedes, supersededRefs } from "../dist/supersede.js";
import { deriveTitle, TITLE_MAX } from "../dist/title.js";
import { matchExpression, phraseExpression, queryTerms } from "../dist/ranking.js";

test("SUPERSEDES reads the ids right after the word, and only those", () => {
  assert.deepEqual(supersededRefs("SUPERSEDES 0a1b2c3d, because the time was wrong."), ["0a1b2c3d"]);
  assert.deepEqual(supersededRefs("SUPERSEDES: 1b2c3d4e. New plan"), ["1b2c3d4e"]);
  assert.deepEqual(supersededRefs("SUPERSEDES 2c3d4e5f, 3d4e5f60 and 4e5f6071 (all old)"), ["2c3d4e5f", "3d4e5f60", "4e5f6071"]);
  assert.deepEqual(supersededRefs("SUPERSEDES 5f607182 & 60718293: both"), ["5f607182", "60718293"]);
  assert.deepEqual(supersededRefs("SUPERSEDES 0A1B2C3D-1111-4222-8333-444455556666 now"), ["0a1b2c3d-1111-4222-8333-444455556666"]);
  // An id after a parenthetical, a partial replacement, a short id, lowercase keyword, mid-text.
  assert.deepEqual(supersededRefs("SUPERSEDES 718293a4 (first) and 8293a4b5 (second)."), ["718293a4"]);
  assert.deepEqual(supersededRefs('SUPERSEDES the "cache" decision in "Old notes" (93a4b5c6)'), []);
  assert.deepEqual(supersededRefs("SUPERSEDES 1234567 is too short"), []);
  assert.deepEqual(supersededRefs("Supersedes a4b5c6d7 for state."), []);
  assert.deepEqual(supersededRefs("STATE: merged. SUPERSEDES 0a1b2c3d"), []);
  assert.equal(startsWithSupersedes("\n SUPERSEDES 0a1b2c3d"), true);
  assert.equal(startsWithSupersedes("It SUPERSEDES 0a1b2c3d"), false);
});

test("state keys need a known namespace and a tidy shape", () => {
  assert.deepEqual(validateStateKey(" Config:Theme "), { ok: true, key: "config:theme" });
  assert.equal(validateStateKey("status:build:main").ok, true);
  assert.equal(validateStateKey("theme").ok, false);
  assert.equal(validateStateKey("unknown:theme").ok, false);
  assert.equal(validateStateKey("config:-bad").ok, false);
  assert.equal(validateStateKey("config:a:b:c").ok, false);
  assert.equal(validateStateKey(`config:${"x".repeat(80)}`).ok, false);
});

test("a missing title comes from the first real line", () => {
  assert.equal(deriveTitle("\n\n## Cache fix\nmore"), "Cache fix");
  assert.equal(deriveTitle("- **Fixed** the `parse_feed` timeout"), "Fixed the parse_feed timeout");
  const long = deriveTitle("A very long first line that keeps going well past the sixty character limit for titles");
  assert.ok(long.length <= TITLE_MAX);
  assert.equal(deriveTitle("x".repeat(90)), "x".repeat(TITLE_MAX));
  assert.ok(deriveTitle(`${"a".repeat(59)}🧠 tail`).isWellFormed());
  assert.equal(deriveTitle("   \n**"), null);
});

test("queries become quoted FTS5 terms, so operators in a query are just words", () => {
  assert.deepEqual(queryTerms("Reset NOT peer, reset!"), ["reset", "not", "peer"]);
  assert.equal(matchExpression(["reset", "not"]), '"reset" OR "not"');
  assert.equal(matchExpression([]), null);
  assert.equal(phraseExpression("connection reset-by peer"), '"connection reset by peer"');
  assert.equal(phraseExpression("single"), null);
});
