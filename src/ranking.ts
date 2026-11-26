// Keyword ranking for the local store. Search is full-text over title, content and tags,
// scored by SQLite FTS5's BM25. It matches words, not meaning.
//
// Order of results:
//   1. Notes that contain the whole query as an exact phrase come first, as long as the
//      phrase is rare (PHRASE_MAX notes or fewer). A pasted error string or command lands
//      on top; a common phrase changes nothing.
//   2. Then the BM25 score, nudged by two small factors: session summaries (category
//      "context") rank a little lower, and newer notes get a small bonus.

export const PHRASE_MAX = 20;

// Column weights for bm25(): the hidden id column, then title, content, tags.
export const BM25_WEIGHTS = [0, 4, 1, 2] as const;

const CONTEXT_FACTOR = 0.9;
const RECENCY_BONUS = 0.1;
const RECENCY_DAYS = 90;

// The words in a query, lowercased and deduplicated. FTS5's unicode61 tokenizer splits on
// anything that isn't a letter or digit, so this does the same.
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)];
}

// Any word may match; BM25 ranks notes with more of the words, and rarer ones, higher.
// Each word is quoted so FTS5 never reads it as an operator.
export function matchExpression(terms: string[]): string | null {
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

// The whole query as one phrase, for queries of two words or more.
export function phraseExpression(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.length >= 2 ? `"${words.join(" ")}"` : null;
}

// bm25() is negative, lower is better. This turns it into a higher-is-better score.
export function finalScore(bm25: number, category: string, createdAt: string, now: Date): number {
  const relevance = -bm25;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(createdAt)) / 86_400_000);
  const recency = 1 + RECENCY_BONUS * Math.exp(-ageDays / RECENCY_DAYS);
  const context = category === "context" ? CONTEXT_FACTOR : 1;
  return relevance * recency * context;
}

export interface Ranked {
  phrase: boolean;
  score: number;
}

export function compareRanked(a: Ranked, b: Ranked): number {
  if (a.phrase !== b.phrase) return a.phrase ? -1 : 1;
  return b.score - a.score;
}
