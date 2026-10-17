// Staging operations: files and individual hunks.
//
// Two things worth stating up front.
//
// .gitignore is respected by construction. `git add` already refuses to add
// ignored paths; we never pass -f unless the caller explicitly asks (opts.force),
// so "never stage ignored files without explicit force" is the default, not an
// extra check we could forget.
//
// Hunk staging works by slicing one hunk out of the exact `git diff` output and
// feeding that byte-identical patch back through `git apply --cached`. We keep
// the original preamble (index line, modes, --- / +++) untouched, so what git
// applies is what git produced.
//
// Every path goes through validatePaths/resolveInRoot first, and every git call
// is scoped to ctx.root.

import { validatePaths, resolveInRoot } from "./discover.js";

/** @typedef {{ ok: boolean, staged: string[], errors: string[] }} StageResult */

/**
 * Slice a single hunk (with its file preamble) out of a raw unified diff.
 * @param {string} raw
 * @param {number} hunkIndex
 * @returns {{ ok: boolean, patch: string|null, error: string|null }}
 */
export function sliceHunkPatch(raw, hunkIndex) {
  const lines = String(raw ?? "").split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk === -1) return { ok: false, patch: null, error: "diff has no hunks" };

  const preamble = lines.slice(0, firstHunk);
  /** @type {string[][]} */
  const blocks = [];
  /** @type {string[]|null} */
  let block = null;
  for (let i = firstHunk; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("@@")) {
      if (block) blocks.push(block);
      block = [l];
    } else if (block) {
      // A second file in the same raw diff ends the current file's hunks.
      if (l.startsWith("diff --git ")) {
        blocks.push(block);
        block = null;
      } else {
        block.push(l);
      }
    }
  }
  if (block) blocks.push(block);

  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= blocks.length) {
    return { ok: false, patch: null, error: `hunk index ${hunkIndex} out of range (0..${blocks.length - 1})` };
  }

  const slice = [...preamble, ...blocks[hunkIndex]];
  while (slice.length && slice[slice.length - 1] === "") slice.pop();
  return { ok: true, patch: `${slice.join("\n")}\n`, error: null };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {unknown[]} paths
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<StageResult>}
 */
export async function stageFiles(ctx, paths, opts = {}) {
  const v = validatePaths(ctx.root, paths);
  if (v.paths.length === 0) {
    return { ok: false, staged: [], errors: v.errors.length ? v.errors : ["no paths given"] };
  }
  const args = ["add"];
  if (opts.force) args.push("-f");
  args.push("--", ...v.paths);
  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, staged: [], errors: [...v.errors, res.error] };
  return { ok: v.errors.length === 0, staged: v.paths, errors: v.errors };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {unknown[]} paths
 * @returns {Promise<StageResult>}
 */
export async function unstageFiles(ctx, paths) {
  const v = validatePaths(ctx.root, paths);
  if (v.paths.length === 0) {
    return { ok: false, staged: [], errors: v.errors.length ? v.errors : ["no paths given"] };
  }
  let res = await ctx.run(["restore", "--staged", "--", ...v.paths]);
  if (!res.ok) {
    // `restore` needs a commit to restore from; in a repo with no HEAD (or an
    // older git) fall back to reset, which does the same thing here.
    res = await ctx.run(["reset", "-q", "--", ...v.paths]);
  }
  if (!res.ok) return { ok: false, staged: [], errors: [...v.errors, res.error] };
  return { ok: v.errors.length === 0, staged: v.paths, errors: v.errors };
}

/** @param {import("./discover.js").GitContext} ctx @param {{ force?: boolean }} [opts] @returns {Promise<StageResult>} */
export async function stageAll(ctx, opts = {}) {
  const args = ["add", "-A"];
  if (opts.force) args.push("-f");
  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, staged: [], errors: [res.error] };
  return { ok: true, staged: [], errors: [] };
}

/** @param {import("./discover.js").GitContext} ctx @returns {Promise<StageResult>} */
export async function unstageAll(ctx) {
  let res = await ctx.run(["restore", "--staged", "."]);
  if (!res.ok) res = await ctx.run(["reset", "-q"]);
  if (!res.ok) return { ok: false, staged: [], errors: [res.error] };
  return { ok: true, staged: [], errors: [] };
}

async function applyHunk(ctx, relPath, hunkIndex, { cached, reverse }) {
  const diffArgs = ["diff", "--no-color"];
  if (cached) diffArgs.push("--cached");
  diffArgs.push("--", relPath);
  const diff = await ctx.run(diffArgs);
  if (!diff.ok) return { ok: false, staged: [], errors: [diff.error] };
  if (!diff.stdout.trim()) {
    return { ok: false, staged: [], errors: [`no ${cached ? "staged" : "unstaged"} changes in ${relPath}`] };
  }
  const sliced = sliceHunkPatch(diff.stdout, hunkIndex);
  if (!sliced.ok) return { ok: false, staged: [], errors: [sliced.error] };

  const args = ["apply", "--cached", "--whitespace=nowarn"];
  if (reverse) args.push("--reverse");
  const applied = await ctx.runInput(args, sliced.patch);
  if (!applied.ok) return { ok: false, staged: [], errors: [applied.error] };
  return { ok: true, staged: [relPath], errors: [] };
}

/**
 * Stage one hunk of a file's unstaged changes.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} file
 * @param {number} hunkIndex
 * @returns {Promise<StageResult>}
 */
export async function stageHunk(ctx, file, hunkIndex) {
  const rp = resolveInRoot(ctx.root, file);
  if (!rp.ok) return { ok: false, staged: [], errors: [`${file}: ${rp.error}`] };
  return applyHunk(ctx, rp.relPath, hunkIndex, { cached: false, reverse: false });
}

/**
 * Unstage one hunk of a file's staged changes.
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} file
 * @param {number} hunkIndex
 * @returns {Promise<StageResult>}
 */
export async function unstageHunk(ctx, file, hunkIndex) {
  const rp = resolveInRoot(ctx.root, file);
  if (!rp.ok) return { ok: false, staged: [], errors: [`${file}: ${rp.error}`] };
  return applyHunk(ctx, rp.relPath, hunkIndex, { cached: true, reverse: true });
}

export default { stageFiles, unstageFiles, stageAll, unstageAll, stageHunk, unstageHunk, sliceHunkPatch };
