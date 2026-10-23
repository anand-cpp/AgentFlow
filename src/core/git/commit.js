// Commit creation, conventional-message validation, and message generation.
//
// Message generation has two tiers. The default is a deterministic heuristic
// over the staged diff -- no model, no network, testable with fixtures. The
// optional tier takes a caller-supplied async function so a model can propose a
// better message; if it fails or returns nothing, the heuristic stands.
//
// createCommit only runs when a caller asks it to. Nothing here stages, pushes,
// or commits on its own.

import fs from "node:fs";
import path from "node:path";
import { parseDiff } from "./diff.js";

const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: .+/;

/** @param {string} p */
function baseName(p) {
  const parts = String(p || "").split("/");
  return parts[parts.length - 1] || "file";
}

/** Scope is the immediate parent directory, or null for a repo-root file. */
function scopeFor(p) {
  const parts = String(p || "").split("/");
  if (parts.length <= 1) return null;
  return parts[parts.length - 2] || null;
}

function looksLikeTest(p) {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

function looksLikeDocs(p) {
  return /(^|\/)docs?\//.test(p) || /\.(md|mdx|rst|txt)$/i.test(p);
}

function looksLikeManifest(p) {
  const b = baseName(p);
  return b === "package.json" || b === "package-lock.json";
}

/**
 * Deterministic conventional-commit message from parsed diff files.
 *
 * @param {Array<{ file?: string|null, newPath?: string|null, oldPath?: string|null, additions?: number, deletions?: number, isNew?: boolean, isDeleted?: boolean }>} files
 * @returns {string}
 */
export function heuristicCommitMessage(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return "chore: update working tree";

  if (list.length > 1) {
    const paths = list.map((f) => f.file || f.newPath || f.oldPath || "");
    if (paths.every(looksLikeDocs)) return `docs: update ${list.length} files`;
    if (paths.every(looksLikeTest)) return `test: update ${list.length} files`;
    if (paths.every(looksLikeManifest)) return "chore(deps): update dependencies";
    return `chore: update ${list.length} files`;
  }

  const f = list[0];
  const path = f.file || f.newPath || f.oldPath || "file";
  const base = baseName(path);
  const scope = scopeFor(path);
  const s = scope ? `(${scope})` : "";
  const allAdditions = f.isNew || ((f.additions ?? 0) > 0 && (f.deletions ?? 0) === 0);
  const allDeletions = f.isDeleted || ((f.deletions ?? 0) > 0 && (f.additions ?? 0) === 0);

  if (looksLikeManifest(path)) return `chore(deps): update ${base}`;
  if (looksLikeDocs(path)) return `${allDeletions ? "docs: remove" : "docs: update"} ${base}`;
  if (looksLikeTest(path)) return `test${s}: ${allDeletions ? "remove" : allAdditions ? "add" : "update"} ${base}`;
  if (allAdditions) return `feat${s}: add ${base}`;
  if (allDeletions) return `refactor${s}: remove ${base}`;
  return `chore${s}: update ${base}`;
}

async function fetchStagedDiff(ctx) {
  const res = await ctx.run(["diff", "--cached", "--no-color"]);
  return res.ok ? res.stdout : "";
}

/**
 * Generate a conventional message from the staged diff. When `stagedDiff` is not
 * supplied it is fetched from git.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} [stagedDiff]
 * @returns {Promise<string>}
 */
export async function generateCommitMessage(ctx, stagedDiff) {
  const diff = typeof stagedDiff === "string" ? stagedDiff : await fetchStagedDiff(ctx);
  return heuristicCommitMessage(parseDiff(diff));
}

/**
 * Like generateCommitMessage, but lets a model improve on the heuristic.
 * llmFn receives { diff, heuristic, instructions } and may return a string or
 * { message }. Any throw or empty result falls back to the heuristic.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {string|undefined} stagedDiff
 * @param {(input: { diff: string, heuristic: string, instructions: string }) => Promise<string | { message?: string } | null | undefined>} llmFn
 * @returns {Promise<string>}
 */
export async function generateCommitMessageWithLLM(ctx, stagedDiff, llmFn) {
  const diff = typeof stagedDiff === "string" ? stagedDiff : await fetchStagedDiff(ctx);
  const heuristic = heuristicCommitMessage(parseDiff(diff));
  if (typeof llmFn !== "function") return heuristic;
  try {
    const result = await llmFn({
      diff,
      heuristic,
      instructions:
        "Write one conventional-commit message (type(scope): description, imperative mood, subject <= 72 chars) for this staged diff.",
    });
    const text = typeof result === "string" ? result : result?.message;
    if (text && text.trim()) return text.trim();
  } catch {
    /* fall through to the heuristic */
  }
  return heuristic;
}

/**
 * Validate a commit message. Length limits are hard errors; a non-conventional
 * subject is a warning, so free-form messages (e.g. "Revert ...") still pass.
 *
 * @param {unknown} message
 * @returns {{ ok: boolean, subject: string, errors: string[], warnings: string[] }}
 */
export function validateCommitMessage(message) {
  const text = typeof message === "string" ? message : "";
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];
  const lines = text.split("\n");
  const subject = lines[0] ?? "";
  if (!text.trim()) errors.push("commit message is empty");
  if (subject.length > 72) errors.push(`subject is ${subject.length} characters (max 72)`);
  if (text.trim() && !CONVENTIONAL.test(subject)) {
    warnings.push("subject is not in conventional-commit form (type(scope): description)");
  }
  lines.forEach((l, i) => {
    if (l.length > 500) errors.push(`line ${i + 1} is ${l.length} characters (max 500)`);
  });
  return { ok: errors.length === 0, subject, errors, warnings };
}

/**
 * Resolve a commit template: the configured commit.template, else a .gitmessage
 * file at the repository root.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @returns {Promise<{ ok: boolean, template: string|null, source: string|null, error: string|null }>}
 */
export async function getCommitTemplate(ctx) {
  const cfg = await ctx.run(["config", "--get", "commit.template"]);
  if (cfg.ok && cfg.stdout.trim()) {
    const file = cfg.stdout.trim();
    try {
      const abs = path.isAbsolute(file) ? file : path.resolve(ctx.root, file);
      return { ok: true, template: fs.readFileSync(abs, "utf8"), source: file, error: null };
    } catch (err) {
      return { ok: false, template: null, source: file, error: `could not read commit.template: ${/** @type {Error} */ (err).message}` };
    }
  }
  try {
    const local = path.join(ctx.root, ".gitmessage");
    if (fs.existsSync(local)) return { ok: true, template: fs.readFileSync(local, "utf8"), source: ".gitmessage", error: null };
  } catch {
    /* no local template */
  }
  return { ok: true, template: null, source: null, error: null };
}

/**
 * Create a commit. Only callers who intend to commit should call this.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} message
 * @param {{ amend?: boolean, signoff?: boolean, all?: boolean, allowEmpty?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, hash: string|null, error: string|null, warnings: string[] }>}
 */
export async function createCommit(ctx, message, opts = {}) {
  const v = validateCommitMessage(message);
  if (!v.ok) return { ok: false, hash: null, error: v.errors.join("; "), warnings: [] };

  const args = ["commit", "-m", String(message)];
  if (opts.amend) args.push("--amend");
  if (opts.signoff) args.push("--signoff");
  if (opts.all) args.push("--all");
  if (opts.allowEmpty) args.push("--allow-empty");

  const res = await ctx.run(args);
  if (!res.ok) {
    const combined = `${res.stdout}\n${res.stderr}`;
    const nothing = /nothing to commit|no changes added to commit|nothing added to commit/.test(combined);
    return { ok: false, hash: null, error: nothing ? "nothing to commit" : res.error, warnings: v.warnings };
  }
  const head = await ctx.run(["rev-parse", "--short", "HEAD"]);
  return { ok: true, hash: head.ok ? head.stdout.trim() : null, error: null, warnings: v.warnings };
}

export default {
  heuristicCommitMessage,
  generateCommitMessage,
  generateCommitMessageWithLLM,
  validateCommitMessage,
  getCommitTemplate,
  createCommit,
};
