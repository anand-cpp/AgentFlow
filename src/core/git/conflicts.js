// Merge-conflict detection and resolution.
//
// Conflict detection reuses the porcelain v2 parser (status.js): an unmerged
// path is a `u` entry, and its three stage hashes are already the base/ours/
// theirs blob ids. We add marker parsing and the resolution verbs on top.
//
// Resolution writes the chosen content and stages it. `ours`/`theirs` are
// delegated to `git checkout --ours|--theirs` so binary and marker-less
// conflicts resolve too; `both` and custom content are written directly (the
// path is proven inside the workspace root first).

import fs from "node:fs";
import path from "node:path";
import { resolveInRoot } from "./discover.js";
import { runStatus } from "./status.js";

/**
 * Unmerged paths from `git status --porcelain=v2`.
 * @param {import("./discover.js").GitContext} ctx
 * @returns {Promise<{ ok: boolean, conflicts: Array<object>, error: string|null }>}
 */
export async function detectConflicts(ctx) {
  const status = await runStatus(ctx);
  if (!status.ok) return { ok: false, conflicts: [], error: status.error };
  const conflicts = status.unmerged.map((u) => ({
    path: u.path,
    status: u.status,
    stages: { base: u.stages.base, ours: u.stages.ours, theirs: u.stages.theirs },
  }));
  return { ok: true, conflicts, error: null };
}

/**
 * Locate <<<<<<< / ======= / >>>>>>> blocks (with optional ||||||| base) and,
 * when a strategy is given, rebuild the content with the chosen side(s).
 *
 * @param {string} content
 * @param {"ours"|"theirs"|"both"} strategy
 * @returns {{ conflicts: Array<object>, result: string }}
 */
function scan(content, strategy) {
  const lines = String(content ?? "").split("\n");
  /** @type {any[]} */
  const conflicts = [];
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const start = i;
      const oursLabel = lines[i].slice(7).trim();
      const oursLines = [];
      i++;
      /** @type {string[]|null} */
      let baseLines = null;
      let baseLabel = null;
      while (i < lines.length && !lines[i].startsWith("|||||||") && !lines[i].startsWith("=======")) {
        oursLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith("|||||||")) {
        baseLabel = lines[i].slice(7).trim();
        baseLines = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("=======")) {
          baseLines.push(lines[i]);
          i++;
        }
      }
      const divider = i; // index of =======
      i++;
      const theirsLines = [];
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        theirsLines.push(lines[i]);
        i++;
      }
      const end = i; // index of >>>>>>>
      const theirsLabel = i < lines.length ? lines[i].slice(7).trim() : "";
      i++;

      conflicts.push({
        start,
        divider,
        end,
        ours: oursLines.join("\n"),
        theirs: theirsLines.join("\n"),
        base: baseLines ? baseLines.join("\n") : null,
        oursLabel: oursLabel || null,
        theirsLabel: theirsLabel || null,
        baseLabel: baseLabel || null,
        branchLabels: [oursLabel || null, theirsLabel || null],
      });

      const chosen =
        strategy === "ours" ? oursLines : strategy === "theirs" ? theirsLines : [...oursLines, ...theirsLines];
      out.push(...chosen);
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return { conflicts, result: out.join("\n") };
}

/**
 * Find conflict-marker blocks without changing anything.
 * @param {string} content
 */
export function parseConflictMarkers(content) {
  return scan(content, "ours").conflicts;
}

/**
 * Rebuild content from a resolved strategy.
 * @param {string} content
 * @param {"ours"|"theirs"|"both"} strategy
 */
export function resolveMarkers(content, strategy = "both") {
  const { conflicts, result } = scan(content, strategy);
  return { content: result, conflicts };
}

/**
 * Resolve one conflicted path.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} p
 * @param {"ours"|"theirs"|"both"|string} resolution
 * @returns {Promise<{ ok: boolean, path: string|null, error: string|null }>}
 */
export async function resolveConflict(ctx, p, resolution) {
  const rp = resolveInRoot(ctx.root, p);
  if (!rp.ok) return { ok: false, path: null, error: rp.error };

  if (resolution === "ours" || resolution === "theirs") {
    const res = await ctx.run(["checkout", `--${resolution}`, "--", rp.relPath]);
    if (!res.ok) return { ok: false, path: rp.relPath, error: res.error };
  } else {
    const abs = path.join(ctx.root, rp.relPath);
    let content;
    if (resolution === "both") {
      const current = fs.readFileSync(abs, "utf8");
      content = resolveMarkers(current, "both").content;
    } else {
      content = String(resolution);
    }
    fs.writeFileSync(abs, content);
  }

  const stage = await ctx.run(["add", "--", rp.relPath]);
  if (!stage.ok) return { ok: false, path: rp.relPath, error: stage.error };
  return { ok: true, path: rp.relPath, error: null };
}

/** Resolve the absolute git dir (handles linked worktrees). */
async function gitDir(ctx) {
  const r = await ctx.run(["rev-parse", "--absolute-git-dir"]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : path.join(ctx.root, ".git");
}

/** @param {import("./discover.js").GitContext} ctx */
export async function isMergeInProgress(ctx) {
  return fs.existsSync(path.join(await gitDir(ctx), "MERGE_HEAD"));
}

/** @param {import("./discover.js").GitContext} ctx */
export async function isRebaseInProgress(ctx) {
  const dir = await gitDir(ctx);
  return fs.existsSync(path.join(dir, "rebase-merge")) || fs.existsSync(path.join(dir, "rebase-apply"));
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function abortMerge(ctx) {
  const res = await ctx.run(["merge", "--abort"]);
  return { ok: res.ok, error: res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function abortRebase(ctx) {
  const res = await ctx.run(["rebase", "--abort"]);
  return { ok: res.ok, error: res.error };
}

export default {
  detectConflicts,
  parseConflictMarkers,
  resolveMarkers,
  resolveConflict,
  isMergeInProgress,
  isRebaseInProgress,
  abortMerge,
  abortRebase,
};
