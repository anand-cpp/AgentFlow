// Log and history browsing.
//
// Structured output comes from a NUL/RS-delimited `--format`, not from parsing
// human-readable log text. Records are separated by RS (0x1e); fields by NUL
// (0x00), so subjects and bodies containing any ordinary punctuation survive.

import { resolveInRoot } from "./discover.js";

const FMT = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%D%x00%s%x00%b";
const RS = "\x1e";

/** Split a git ref decoration string ("HEAD -> main, origin/main, tag: v1") into names. */
export function parseRefs(decoration) {
  return String(decoration || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse RS/NUL-delimited `git log` output.
 * @param {string} raw
 */
export function parseLog(raw) {
  /** @type {any[]} */
  const commits = [];
  for (const record of String(raw || "").split(RS)) {
    const text = record.replace(/^\n+/, "");
    if (!text.trim()) continue;
    const parts = text.split("\x00");
    if (parts.length < 9) continue;
    const [hash, shortHash, author, authorEmail, date, parents, refs, subject] = parts;
    const body = parts.slice(8).join("\x00").replace(/\n+$/, "");
    commits.push({
      hash,
      shortHash,
      author,
      authorEmail,
      date,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      refs: parseRefs(refs),
      subject,
      body,
    });
  }
  return commits;
}

function baseLogArgs(opts) {
  const args = ["log"];
  if (opts.limit) args.push("-n", String(opts.limit));
  if (opts.author) args.push(`--author=${opts.author}`);
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  if (opts.grep) args.push(`--grep=${opts.grep}`);
  if (opts.all) args.push("--all");
  return args;
}

/**
 * Browse history.
 *
 * By default returns structured commits. Passing any of `oneline`, `graph`, or
 * `raw` switches to raw-text mode and returns git's own rendering in `text`.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {{ limit?: number, author?: string, since?: string, until?: string, grep?: string, all?: boolean, path?: string, ref?: string, oneline?: boolean, graph?: boolean, raw?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, commits: any[], text: string|null, error: string|null }>}
 */
export async function getLog(ctx, opts = {}) {
  const args = baseLogArgs(opts);
  const rawMode = Boolean(opts.oneline || opts.graph || opts.raw);
  if (rawMode) {
    if (opts.oneline) args.push("--oneline");
    if (opts.graph) args.push("--graph");
    args.push(opts.ref || "HEAD");
  } else {
    args.push(`--format=${FMT}${RS}`);
    args.push(opts.ref || "HEAD");
  }
  if (opts.path) {
    const rp = resolveInRoot(ctx.root, opts.path);
    if (!rp.ok) return { ok: false, commits: [], text: null, error: rp.error };
    args.push("--", rp.relPath);
  }
  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, commits: [], text: null, error: res.error };
  if (rawMode) return { ok: true, commits: [], text: res.stdout.replace(/\n+$/, ""), error: null };
  return { ok: true, commits: parseLog(res.stdout), text: null, error: null };
}

/**
 * Show a single commit's metadata and diff.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} ref
 */
export async function getCommit(ctx, ref) {
  const res = await ctx.run(["show", "--no-color", `--format=${FMT}${RS}`, ref]);
  if (!res.ok) return { ok: false, meta: null, diff: "", error: res.error };
  const idx = res.stdout.indexOf(RS);
  const header = idx >= 0 ? res.stdout.slice(0, idx) : res.stdout;
  const rest = idx >= 0 ? res.stdout.slice(idx + 1) : "";
  const meta = parseLog(`${header}${RS}`)[0] || null;
  return { ok: true, meta, diff: rest.replace(/^\n+/, ""), error: null };
}

/**
 * History for one path, following renames.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} file
 * @param {{ limit?: number }} [opts]
 */
export async function getFileHistory(ctx, file, opts = {}) {
  const rp = resolveInRoot(ctx.root, file);
  if (!rp.ok) return { ok: false, commits: [], error: rp.error };
  const args = ["log", "--follow", `--format=${FMT}${RS}`];
  if (opts.limit) args.push("-n", String(opts.limit));
  args.push("--", rp.relPath);
  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, commits: [], error: res.error };
  return { ok: true, commits: parseLog(res.stdout), error: null };
}

/**
 * Parse `git blame --porcelain` output.
 * @param {string} raw
 */
export function parseBlame(raw) {
  const lines = String(raw || "").split("\n");
  /** @type {any[]} */
  const entries = [];
  /** @type {Map<string, any>} */
  const cache = new Map();
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (!m) {
      i++;
      continue;
    }
    const hash = m[1];
    const finalLine = Number(m[2]);
    const known = cache.get(hash) || {};
    i++;
    /** @type {Record<string, string>} */
    const pending = {};
    while (i < lines.length && !lines[i].startsWith("\t")) {
      const l = lines[i];
      const sp = l.indexOf(" ");
      if (sp === -1) pending[l] = "";
      else pending[l.slice(0, sp)] = l.slice(sp + 1);
      i++;
    }
    const content = i < lines.length ? lines[i].slice(1) : "";
    i++;
    const author = pending.author || known.author || null;
    const email = pending["author-mail"] ? pending["author-mail"].replace(/[<>]/g, "") : known.email || null;
    const date = pending["author-time"]
      ? new Date(Number(pending["author-time"]) * 1000).toISOString()
      : known.date || null;
    const summary = pending.summary || known.summary || null;
    cache.set(hash, { author, email, date, summary });
    entries.push({ hash, line: finalLine, author, email, date, summary, content });
  }
  return entries;
}

/**
 * Per-line blame for a file.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} file
 * @param {{ start?: number, end?: number }} [opts]
 */
export async function getBlame(ctx, file, opts = {}) {
  const rp = resolveInRoot(ctx.root, file);
  if (!rp.ok) return { ok: false, lines: [], error: rp.error };
  const args = ["blame", "--porcelain"];
  if (opts.start && opts.end) args.push("-L", `${opts.start},${opts.end}`);
  args.push("--", rp.relPath);
  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, lines: [], error: res.error };
  return { ok: true, lines: parseBlame(res.stdout), error: null };
}

/**
 * Search commit messages.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} query
 * @param {{ limit?: number, all?: boolean, ref?: string }} [opts]
 */
export async function searchLog(ctx, query, opts = {}) {
  return getLog(ctx, { ...opts, grep: query });
}

export default { parseRefs, parseLog, getLog, getCommit, getFileHistory, parseBlame, getBlame, searchLog };
