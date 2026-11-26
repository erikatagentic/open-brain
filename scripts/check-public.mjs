#!/usr/bin/env node
// check-public.mjs: a last look before this folder goes public. It walks every text file and
// reports anything that looks private:
//   phone numbers, private network addresses, hosted-app and automation hostnames, chat
//   webhook URLs, a variable whose name ends in key, token, secret or password with a value
//   after it (except the field names in NOT_SECRET_NAMES), and any email address outside the
//   made-up example domains.
//
//   node scripts/check-public.mjs [folder]     (default: the repo root)
//
// Exit 0 when clean, 1 on any hit. Each hit prints as "<label> <file>:<line> <match>", with
// key values hidden.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const ALLOWED_EMAILS = new Set(['erik@erikhernal.com']);
const SAFE_SUFFIXES = ['example.com', 'example.org', 'example.net'];
const SAFE_TLDS = ['test', 'example'];
// Field names that end in "_key" but never hold a secret. state_key is brain_save's argument
// for a current-value fact (config:theme), so it shows up with a value all over the code.
const NOT_SECRET_NAMES = new Set(['state_key']);

export function isSafeDomain(domain) {
  const d = String(domain).toLowerCase().replace(/\.+$/, '');
  if (SAFE_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`))) return true;
  return d.includes('.') && SAFE_TLDS.includes(d.split('.').pop());
}

export function isAllowedEmail(address) {
  const a = String(address).toLowerCase();
  return ALLOWED_EMAILS.has(a) || isSafeDomain(a.slice(a.lastIndexOf('@') + 1));
}

// Each pattern is written so its own source text doesn't match it.
export const PATTERNS = [
  { label: 'phone', re: /(?<![\w+.])(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.-]*\d)/ },
  { label: 'phone', re: /(?<![\w])\+1\d{10}\b/ },
  { label: 'private IP', re: /\b(?:10\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b(?!\.\d)/ },
  { label: 'internal host', re: /[\w-]+\.(?:onrender\.com|fly\.dev)\b/i },
  { label: 'internal host', re: /\b(?:[\w-]+\.)*[\w-]*n8n[\w-]*\.[a-z][\w-]*(?:\.[a-z][\w-]*)*\b/i },
  { label: 'webhook', re: /hooks\.slack\.com/i },
  { label: 'key with value', re: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:key|token|secret|password)\b["']?\s*[:=]\s*["']?[^\s"'#,;)]{4,}/i, hide: true,
    keep: (m) => !NOT_SECRET_NAMES.has(m.split(/["'\s:=]/)[0].toLowerCase()) },
  { label: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, keep: (m) => !isAllowedEmail(m) },
];

export function scanText(text) {
  const hits = [];
  String(text).split('\n').forEach((line, i) => {
    for (const p of PATTERNS) {
      const re = new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`);
      for (const m of line.matchAll(re)) {
        if (p.keep && !p.keep(m[0])) continue;
        hits.push({ label: p.label, line: i + 1, match: p.hide ? '[value hidden]' : m[0].slice(0, 60) });
      }
    }
  });
  return hits;
}

export function scanDir(root) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
      if (!entry.isFile()) continue;
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue;   // binary
      for (const h of scanText(buf.toString('utf8'))) hits.push({ ...h, file: path.relative(root, full) });
    }
  };
  walk(root);
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const hits = scanDir(root);
  for (const h of hits) console.log(`${h.label} ${h.file}:${h.line} ${h.match}`);
  console.log(hits.length ? `check-public: ${hits.length} hit(s) in ${root}` : `check-public: clean (${root})`);
  process.exitCode = hits.length ? 1 : 0;
}
