// Stash operations.
//
// `git stash list` is read with a NUL-delimited format so the WIP subject (which
// often contains the branch and a commit subject) parses reliably.

import { resolveInRoot } from "./discover.js";

const NUL = "\x00";
const FMT = `%gd%x00%gs`;

/**
 * Build a stash reference from a number, an existing `stash@{n}` string, or
 * nothing (defaults to the most recent entry).
 * @param {number|string|null|undefined} index
 */
export function stashRef(index) {
  if (index === undefined || index === null || index === "") return "stash@{0}";
  if (typeof index === "number") return `stash@{${index}}`;
  const s = String(index).trim();
  if (/^\d+$/.test(s)) return `stash@{${s}}`;
  return s;
}

function validRef(ref) {
  return /^stash@\{\d+\}$/.test(ref);
}

/**
 * Parse `git stash list --format=%gd%x00%gs`.
 * @param {string} raw
 */
export function parseStashList(raw) {
  /** @type {any[]} */
  const stashes = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    const [ref, subject = ""] = line.split(NUL);
    const m = ref.match(/^stash@\{(\d+)\}$/);
    if (!m) continue;
    const sm = subject.match(/^(WIP on|On) ([^:]+): (.*)$/);
    stashes.push({
      index: Number(m[1]),
      ref,
      branch: sm ? sm[2] : null,
      message: sm ? sm[3] : subject,
      auto: subject.startsWith("WIP on"),
      subject,
    });
  }
  return stashes;
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @returns {Promise<{ ok: boolean, stashes: any[], error: string|null }>}
 */
export async function stashList(ctx) {
  const res = await ctx.run(["stash", "list", `--format=${FMT}`]);
  if (!res.ok) return { ok: false, stashes: [], error: res.error };
  return { ok: true, stashes: parseStashList(res.stdout), error: null };
}

/**
 * Create a stash.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} [message]
 * @param {{ includeUntracked?: boolean, keepIndex?: boolean, paths?: string[] }} [opts]
 * @returns {Promise<{ ok: boolean, ref: string|null, hash: string|null, error: string|null }>}
 */
export async function stashSave(ctx, message, opts = {}) {
  const args = ["stash", "push"];
  if (message) args.push("-m", String(message));
  if (opts.includeUntracked) args.push("--include-untracked");
  if (opts.keepIndex) args.push("--keep-index");
  if (opts.paths && opts.paths.length) {
    const resolved = [];
    for (const p of opts.paths) {
      const rp = resolveInRoot(ctx.root, p);
      if (!rp.ok) return { ok: false, ref: null, hash: null, error: rp.error };
      resolved.push(rp.relPath);
    }
    args.push("--", ...resolved);
  }
  const res = await ctx.run(args);
  // `git stash push` prints "No local changes to save" and still exits 0, so a
  // successful exit alone is not proof a stash was made. Treat that message as
  // the no-op it is, in both the success and failure paths.
  const nothing = /No local changes to save/i.test(`${res.stdout}\n${res.stderr}`);
  if (!res.ok) {
    return { ok: false, ref: null, hash: null, error: nothing ? "no local changes to save" : res.error };
  }
  if (nothing) return { ok: false, ref: null, hash: null, error: "no local changes to save" };
  const hash = await ctx.run(["rev-parse", "--verify", "refs/stash"]);
  return { ok: true, ref: "stash@{0}", hash: hash.ok ? hash.stdout.trim() : null, error: null };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {number|string} [index]
 * @param {{ reinstateIndex?: boolean }} [opts]
 */
export async function stashPop(ctx, index, opts = {}) {
  const ref = stashRef(index);
  if (!validRef(ref)) return { ok: false, ref, error: `invalid stash reference: ${ref}` };
  const res = await ctx.run(["stash", "pop", ...(opts.reinstateIndex ? ["--index"] : []), ref]);
  return { ok: res.ok, ref, error: res.ok ? null : res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {number|string} [index]
 * @param {{ reinstateIndex?: boolean }} [opts]
 */
export async function stashApply(ctx, index, opts = {}) {
  const ref = stashRef(index);
  if (!validRef(ref)) return { ok: false, ref, error: `invalid stash reference: ${ref}` };
  const res = await ctx.run(["stash", "apply", ...(opts.reinstateIndex ? ["--index"] : []), ref]);
  return { ok: res.ok, ref, error: res.ok ? null : res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {number|string} [index]
 */
export async function stashDrop(ctx, index) {
  const ref = stashRef(index);
  if (!validRef(ref)) return { ok: false, ref, error: `invalid stash reference: ${ref}` };
  const res = await ctx.run(["stash", "drop", ref]);
  return { ok: res.ok, ref, error: res.ok ? null : res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 */
export async function stashClear(ctx) {
  const res = await ctx.run(["stash", "clear"]);
  return { ok: res.ok, error: res.ok ? null : res.error };
}

/**
 * Show a stash as a patch.
 * @param {import("./discover.js").GitContext} ctx
 * @param {number|string} [index]
 */
export async function stashShow(ctx, index) {
  const ref = stashRef(index);
  if (!validRef(ref)) return { ok: false, ref, diff: "", error: `invalid stash reference: ${ref}` };
  const res = await ctx.run(["stash", "show", "-p", "--include-untracked", "--no-color", ref]);
  return { ok: res.ok, ref, diff: res.ok ? res.stdout : "", error: res.ok ? null : res.error };
}

export default {
  stashRef,
  parseStashList,
  stashList,
  stashSave,
  stashPop,
  stashApply,
  stashDrop,
  stashClear,
  stashShow,
};
