import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BM25_WEIGHTS,
  PHRASE_MAX,
  compareRanked,
  finalScore,
  matchExpression,
  phraseExpression,
  queryTerms,
} from "./ranking.js";
import type { SupersedeRow } from "./supersede.js";

export interface Note {
  id: string;
  title: string | null;
  content: string;
  category: string;
  project: string | null;
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
  state_key: string | null;
  superseded_by: string | null;
  archived: boolean;
  retrieval_count: number;
  last_retrieved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewNote {
  title: string | null;
  content: string;
  category: string;
  project: string | null;
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface SaveResult {
  note: Note;
  // Ids archived because they held the same state key.
  replaced: string[];
  // One row per SUPERSEDES ref.
  supersede: SupersedeRow[];
}

export interface SearchHit {
  note: Note;
  score: number;
  phrase: boolean;
}

export interface Filters {
  // undefined = any project, null = only notes with no project, a string = that project.
  project?: string | null;
  category?: string | null;
}

export interface Stats {
  total: number;
  addedSince: number;
  archived: number;
  byCategory: { category: string; count: number }[];
  byProject: { project: string | null; count: number }[];
}

export type IdLookup =
  | { status: "found"; note: Note }
  | { status: "not_found" }
  | { status: "ambiguous"; count: number }
  | { status: "invalid" };

// Everything the tools need from storage. The tools never see SQL, so another backend
// (Postgres with vectors, say) only has to implement this.
export interface Store {
  save(note: NewNote, opts?: { stateKey?: string; supersedes?: string[] }): SaveResult;
  findTitleSince(title: string, sinceIso: string): Note | null;
  search(query: string, filters: Filters, limit: number): SearchHit[];
  recent(filters: Filters, limit: number): Note[];
  bumpRetrieval(ids: string[]): void;
  // project: undefined = all, null = only notes with no project, a string = that project.
  stats(project: string | null | undefined, sinceIso: string): Stats;
  countProject(project: string | null): number;
  renameProject(from: string | null, to: string | null): number;
  findById(ref: string): IdLookup;
  delete(id: string): boolean;
  close(): void;
}

export interface SqliteStoreOptions {
  path: string;
  now?: () => Date;
  newId?: () => string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  project TEXT,
  source TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  state_key TEXT,
  superseded_by TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thoughts_created_idx ON thoughts (created_at);
CREATE INDEX IF NOT EXISTS thoughts_title_idx ON thoughts (title, created_at);
-- Only one live note may hold a state key at a time.
CREATE UNIQUE INDEX IF NOT EXISTS thoughts_state_key_live_idx
  ON thoughts (state_key) WHERE state_key IS NOT NULL AND archived = 0;
CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
  id UNINDEXED, title, content, tags, tokenize = 'porter unicode61'
);
`;

type Row = Record<string, unknown>;

function toNote(r: Row): Note {
  return {
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    content: r.content as string,
    category: r.category as string,
    project: (r.project as string | null) ?? null,
    source: r.source as string,
    tags: JSON.parse(r.tags as string),
    metadata: JSON.parse(r.metadata as string),
    state_key: (r.state_key as string | null) ?? null,
    superseded_by: (r.superseded_by as string | null) ?? null,
    archived: Number(r.archived) === 1,
    retrieval_count: Number(r.retrieval_count),
    last_retrieved_at: (r.last_retrieved_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

// A full id or a hex prefix of 8 to 32 characters, hyphens ignored. Null when it is neither.
export function idPrefix(ref: string): string | null {
  const hex = ref.trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{8,32}$/.test(hex) ? hex : null;
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private now: () => Date;
  private newId: () => string;

  constructor(opts: SqliteStoreOptions) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    // WAL lets several agents read while one writes; the timeout waits out a short lock.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/fts5/i.test(msg)) {
        throw new Error(`This Node build's SQLite has no FTS5 full-text search (${msg}). Use Node 22.13 or newer.`);
      }
      throw err;
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private get(id: string): Note | null {
    const r = this.db.prepare("SELECT * FROM thoughts WHERE id = ?").get(id) as Row | undefined;
    return r ? toNote(r) : null;
  }

  // Rows whose id starts with the prefix, at most `cap`.
  private byPrefix(hex: string, excludeId: string | null, cap: number): Note[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM thoughts WHERE replace(id, '-', '') LIKE ? AND id IS NOT ? LIMIT ?"
      )
      .all(`${hex}%`, excludeId, cap) as Row[];
    return rows.map(toNote);
  }

  save(input: NewNote, opts: { stateKey?: string; supersedes?: string[] } = {}): SaveResult {
    return this.tx(() => {
      const id = this.newId();
      const at = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO thoughts (id, title, content, category, project, source, tags, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.title,
          input.content,
          input.category,
          input.project,
          input.source,
          JSON.stringify(input.tags),
          JSON.stringify(input.metadata),
          at,
          at
        );
      this.db
        .prepare("INSERT INTO thoughts_fts (id, title, content, tags) VALUES (?, ?, ?, ?)")
        .run(id, input.title ?? "", input.content, input.tags.join(" "));

      // State key: archive every live note under the key, then give the key to this one.
      let replaced: string[] = [];
      if (opts.stateKey) {
        const rows = this.db
          .prepare("SELECT id FROM thoughts WHERE state_key = ? AND archived = 0 AND id <> ?")
          .all(opts.stateKey, id) as Row[];
        replaced = rows.map((r) => r.id as string);
        this.db
          .prepare(
            "UPDATE thoughts SET archived = 1, superseded_by = ?, updated_at = ? WHERE state_key = ? AND archived = 0 AND id <> ?"
          )
          .run(id, at, opts.stateKey, id);
        this.db.prepare("UPDATE thoughts SET state_key = ? WHERE id = ?").run(opts.stateKey, id);
      }

      // SUPERSEDES: archive a ref only when it matches exactly one live note in this
      // note's project. Anything else is reported back and left alone. Never deletes.
      const supersede: SupersedeRow[] = [];
      for (const ref of opts.supersedes ?? []) {
        const row: SupersedeRow = { ref, status: "invalid", target_id: null, target_title: null, target_project: null };
        const hex = idPrefix(ref);
        if (!hex) {
          supersede.push(row);
          continue;
        }
        const matches = this.byPrefix(hex, id, 2);
        if (matches.length === 0) {
          row.status = "not_found";
        } else if (matches.length > 1) {
          row.status = "ambiguous";
        } else {
          const t = matches[0];
          row.target_id = t.id;
          row.target_title = t.title;
          row.target_project = t.project;
          if (t.archived && t.superseded_by === id) {
            row.status = "archived"; // this save already archived it (its state key, or a repeated ref)
          } else if (t.archived) {
            row.status = "already_archived";
          } else if (t.project !== input.project) {
            row.status = "other_project";
          } else {
            this.db
              .prepare("UPDATE thoughts SET archived = 1, superseded_by = ?, updated_at = ? WHERE id = ?")
              .run(id, at, t.id);
            row.status = "archived";
          }
        }
        supersede.push(row);
      }

      return { note: this.get(id)!, replaced, supersede };
    });
  }

  findTitleSince(title: string, sinceIso: string): Note | null {
    const r = this.db
      .prepare("SELECT * FROM thoughts WHERE title = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
      .get(title, sinceIso) as Row | undefined;
    return r ? toNote(r) : null;
  }

  private matchRows(expr: string, filters: Filters, cap: number): { note: Note; bm25: number }[] {
    const [wId, wTitle, wContent, wTags] = BM25_WEIGHTS;
    const rows = this.db
      .prepare(
        `SELECT t.*, bm25(thoughts_fts, ${wId}, ${wTitle}, ${wContent}, ${wTags}) AS bm
         FROM thoughts_fts JOIN thoughts t ON t.id = thoughts_fts.id
         WHERE thoughts_fts MATCH ?
           AND t.archived = 0
           AND (? = 0 OR t.project IS ?)
           AND (? IS NULL OR t.category = ?)
         ORDER BY bm
         LIMIT ?`
      )
      .all(
        expr,
        filters.project === undefined ? 0 : 1,
        filters.project ?? null,
        filters.category ?? null,
        filters.category ?? null,
        cap
      ) as Row[];
    return rows.map((r) => ({ note: toNote(r), bm25: Number(r.bm) }));
  }

  search(query: string, filters: Filters, limit: number): SearchHit[] {
    const expr = matchExpression(queryTerms(query));
    if (!expr) return [];
    const now = this.now();
    const hits = new Map<string, SearchHit>();
    // Take more candidates than asked for, so the recency and context nudges can reorder them.
    for (const { note, bm25 } of this.matchRows(expr, filters, Math.max(limit * 5, 50))) {
      hits.set(note.id, { note, score: finalScore(bm25, note.category, note.created_at, now), phrase: false });
    }
    const phrase = phraseExpression(query);
    if (phrase) {
      const phraseRows = this.matchRows(phrase, filters, PHRASE_MAX + 1);
      if (phraseRows.length <= PHRASE_MAX) {
        for (const { note, bm25 } of phraseRows) {
          const hit = hits.get(note.id) ?? { note, score: finalScore(bm25, note.category, note.created_at, now), phrase: false };
          hit.phrase = true;
          hits.set(note.id, hit);
        }
      }
    }
    return [...hits.values()].sort(compareRanked).slice(0, limit);
  }

  recent(filters: Filters, limit: number): Note[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM thoughts
         WHERE archived = 0 AND (? = 0 OR project IS ?) AND (? IS NULL OR category = ?)
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(filters.project === undefined ? 0 : 1, filters.project ?? null, filters.category ?? null, filters.category ?? null, limit) as Row[];
    return rows.map(toNote);
  }

  bumpRetrieval(ids: string[]): void {
    if (ids.length === 0) return;
    const at = this.now().toISOString();
    const stmt = this.db.prepare(
      "UPDATE thoughts SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE id = ?"
    );
    this.tx(() => {
      for (const id of ids) stmt.run(at, id);
    });
  }

  stats(project: string | null | undefined, sinceIso: string): Stats {
    const on = project === undefined ? 0 : 1;
    const p = project ?? null;
    const one = (sql: string, ...args: (string | number | null)[]) =>
      Number((this.db.prepare(sql).get(...args) as Row).n);
    const total = one(
      "SELECT count(*) AS n FROM thoughts WHERE archived = 0 AND (? = 0 OR project IS ?)",
      on,
      p
    );
    const addedSince = one(
      "SELECT count(*) AS n FROM thoughts WHERE archived = 0 AND created_at >= ? AND (? = 0 OR project IS ?)",
      sinceIso,
      on,
      p
    );
    const archived = one(
      "SELECT count(*) AS n FROM thoughts WHERE archived = 1 AND (? = 0 OR project IS ?)",
      on,
      p
    );
    const byCategory = (
      this.db
        .prepare(
          `SELECT category, count(*) AS n FROM thoughts
           WHERE archived = 0 AND (? = 0 OR project IS ?)
           GROUP BY category ORDER BY n DESC, category`
        )
        .all(on, p) as Row[]
    ).map((r) => ({ category: r.category as string, count: Number(r.n) }));
    const byProject = project !== undefined
      ? []
      : (
          this.db
            .prepare(
              `SELECT project, count(*) AS n FROM thoughts WHERE archived = 0
               GROUP BY project ORDER BY n DESC, project`
            )
            .all() as Row[]
        ).map((r) => ({ project: (r.project as string | null) ?? null, count: Number(r.n) }));
    return { total, addedSince, archived, byCategory, byProject };
  }

  countProject(project: string | null): number {
    const r = this.db.prepare("SELECT count(*) AS n FROM thoughts WHERE project IS ?").get(project) as Row;
    return Number(r.n);
  }

  renameProject(from: string | null, to: string | null): number {
    const res = this.db
      .prepare("UPDATE thoughts SET project = ?, updated_at = ? WHERE project IS ?")
      .run(to, this.now().toISOString(), from);
    return Number(res.changes);
  }

  findById(ref: string): IdLookup {
    const hex = idPrefix(ref);
    if (!hex) return { status: "invalid" };
    const matches = this.byPrefix(hex, null, 2);
    if (matches.length === 0) return { status: "not_found" };
    if (matches.length > 1) {
      const n = this.db
        .prepare("SELECT count(*) AS n FROM thoughts WHERE replace(id, '-', '') LIKE ?")
        .get(`${hex}%`) as Row;
      return { status: "ambiguous", count: Number(n.n) };
    }
    return { status: "found", note: matches[0] };
  }

  delete(id: string): boolean {
    return this.tx(() => {
      this.db.prepare("DELETE FROM thoughts_fts WHERE id = ?").run(id);
      return Number(this.db.prepare("DELETE FROM thoughts WHERE id = ?").run(id).changes) > 0;
    });
  }

  close(): void {
    this.db.close();
  }
}
