// Branch management: list, create, switch, delete, rename.
//
// Names are validated before they touch git. The allow-list regex alone already
// excludes spaces, backslashes, control characters and the shell metacharacters
// (~ ^ : ? * [), because none of those are in [A-Za-z0-9._/-]. On top of that we
// reject the structural hazards git itself refuses: a leading "-" (which argv
// would read as a flag), "..", "@{", a leading/trailing or doubled "/", and a
// trailing ".lock"/".".
//
// `git switch` is used rather than `git checkout`: switch only moves branches,
// so it cannot accidentally detach HEAD or clobber a path the way checkout can.

/** @param {import("./discover.js").GitContext} ctx */
export async function listBranches(ctx) {
  const res = await ctx.run([
    "branch",
    "--format=%(refname:short) %(objectname:short) %(upstream:short) %(HEAD)",
  ]);
  if (!res.ok) return { ok: false, branches: [], error: res.error };
  return { ok: true, branches: parseBranchList(res.stdout), error: null };
}

/**
 * Parse the output of `git branch --format='%(refname:short) %(objectname:short)
 * %(upstream:short) %(HEAD)'`. Branch names cannot contain spaces, so token
 * splitting is unambiguous; the HEAD field is "*" (current) or empty.
 *
 * @param {string} raw
 */
export function parseBranchList(raw) {
  const out = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) continue;
    const isCurrent = line.trimEnd().endsWith("*");
    const cleaned = isCurrent ? line.replace(/\*\s*$/, "") : line;
    const [name, oid, upstream] = cleaned.trim().split(/\s+/);
    if (!name) continue;
    out.push({ name, oid: oid || null, upstream: upstream || null, isCurrent });
  }
  return out;
}

/**
 * Validate a branch name.
 * @param {unknown} name
 * @returns {{ ok: boolean, name: string|null, error: string|null }}
 */
export function validateBranchName(name) {
  const text = typeof name === "string" ? name : "";
  if (!text) return { ok: false, name: null, error: "branch name is empty" };
  if (text.length > 255) return { ok: false, name: null, error: "branch name is too long" };
  if (!/^[a-zA-Z0-9._/-]+$/.test(text)) {
    return { ok: false, name: null, error: "branch name may contain only letters, digits, '.', '_', '/' and '-'" };
  }
  if (text.startsWith("-")) return { ok: false, name: null, error: "branch name must not start with '-'" };
  if (text.includes("..")) return { ok: false, name: null, error: "branch name must not contain '..'" };
  if (text.includes("@{")) return { ok: false, name: null, error: "branch name must not contain '@{'" };
  if (text === "@") return { ok: false, name: null, error: "branch name must not be '@'" };
  if (text.startsWith("/") || text.endsWith("/")) return { ok: false, name: null, error: "branch name must not start or end with '/'" };
  if (text.includes("//")) return { ok: false, name: null, error: "branch name must not contain '//'" };
  if (text.endsWith(".lock")) return { ok: false, name: null, error: "branch name must not end with '.lock'" };
  if (text.endsWith(".")) return { ok: false, name: null, error: "branch name must not end with '.'" };
  return { ok: true, name: text, error: null };
}

/**
 * A start point is a revision (branch, tag, sha, HEAD~1), which permits a wider
 * character set than a branch name. Still: no leading dash, no spaces, no "..".
 * @param {unknown} rev
 */
export function validateStartPoint(rev) {
  const text = typeof rev === "string" ? rev.trim() : "";
  if (!text) return { ok: false, rev: null, error: "start point is empty" };
  if (text.startsWith("-")) return { ok: false, rev: null, error: "start point must not start with '-'" };
  if (!/^[a-zA-Z0-9._/^~@{}-]+$/.test(text)) return { ok: false, rev: null, error: "start point contains forbidden characters" };
  if (text.includes("..")) return { ok: false, rev: null, error: "start point must not contain '..'" };
  return { ok: true, rev: text, error: null };
}

/** @param {import("./discover.js").GitContext} ctx */
export async function currentBranch(ctx) {
  const res = await ctx.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return { ok: false, name: null, error: res.error };
  const name = res.stdout.trim();
  return { ok: true, name: name === "HEAD" ? null : name, detached: name === "HEAD", error: null };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} name
 * @param {string} [startPoint]
 */
export async function createBranch(ctx, name, startPoint) {
  const v = validateBranchName(name);
  if (!v.ok) return { ok: false, name: null, error: v.error };
  const args = ["branch", v.name];
  if (startPoint !== undefined) {
    const s = validateStartPoint(startPoint);
    if (!s.ok) return { ok: false, name: null, error: s.error };
    args.push(s.rev);
  }
  const res = await ctx.run(args);
  return { ok: res.ok, name: res.ok ? v.name : null, error: res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} name
 */
export async function switchBranch(ctx, name) {
  const v = validateBranchName(name);
  if (!v.ok) return { ok: false, name: null, error: v.error };
  const res = await ctx.run(["switch", v.name]);
  return { ok: res.ok, name: res.ok ? v.name : null, error: res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} name
 * @param {boolean} [force]
 */
export async function deleteBranch(ctx, name, force = false) {
  const v = validateBranchName(name);
  if (!v.ok) return { ok: false, name: null, error: v.error };
  const current = await currentBranch(ctx);
  if (current.ok && current.name === v.name) {
    return { ok: false, name: null, error: `refusing to delete the current branch '${v.name}'` };
  }
  const res = await ctx.run(["branch", force ? "-D" : "-d", v.name]);
  return { ok: res.ok, name: res.ok ? v.name : null, error: res.error };
}

/**
 * @param {import("./discover.js").GitContext} ctx
 * @param {string} oldName
 * @param {string} newName
 */
export async function renameBranch(ctx, oldName, newName) {
  const from = validateBranchName(oldName);
  if (!from.ok) return { ok: false, name: null, error: from.error };
  const to = validateBranchName(newName);
  if (!to.ok) return { ok: false, name: null, error: to.error };
  const res = await ctx.run(["branch", "-m", from.name, to.name]);
  return { ok: res.ok, name: res.ok ? to.name : null, error: res.error };
}

export default {
  listBranches,
  parseBranchList,
  validateBranchName,
  validateStartPoint,
  currentBranch,
  createBranch,
  switchBranch,
  deleteBranch,
  renameBranch,
};
