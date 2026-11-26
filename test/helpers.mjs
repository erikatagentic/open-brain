import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../dist/store.js";
import { createTools } from "../dist/tools.js";

// A fresh data file per test, a clock the test can move, and ids the test can predict.
export function brain(t, { ids } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "open-brain-test-"));
  const clock = { now: new Date("2026-06-01T12:00:00Z") };
  const now = () => new Date(clock.now);
  let n = 0;
  const newId = ids ? () => ids[n++] : undefined;
  const store = new SqliteStore({ path: join(dir, "brain.sqlite3"), now, newId });
  const tools = createTools(store, { now, source: "test" });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const advance = (hours) => {
    clock.now = new Date(clock.now.getTime() + hours * 3_600_000);
  };
  const idOf = (text) => text.match(/\(([0-9a-f-]{36})\)/)[1];
  return { store, tools, advance, idOf };
}
