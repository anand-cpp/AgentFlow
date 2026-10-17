// `aflow git` and the chat `/git` slash command.
//
// One dispatcher, two front doors. The CLI command and the in-chat `/git` both
// call `dispatchGit`, so the surface a user sees in a conversation is the same
// code the shell runs -- no second implementation to drift.
//
// Read operations (status, log, diff, branch, show, blame) are the bulk of it.
// The writes that belong in a workflow -- stage, unstage, commit, stash,
// conflicts -- are here too, but nothing pushes, and nothing rewrites history.
// Every path and branch name is validated inside the git modules before it
// reaches argv.

import process from "node:process";

import { defineCommand } from "../cli/registry.js";
import { GitContext, validateWorkspace } from "../core/git/discover.js";
import { runStatus } from "../core/git/status.js";
import { runDiff, diffStat } from "../core/git/diff.js";
import { stageFiles, unstageFiles } from "../core/git/staging.js";
import { listBranches, currentBranch } from "../core/git/branches.js";
import { createCommit, generateCommitMessage } from "../core/git/commit.js";
import { detectConflicts, resolveConflict, abortMerge } from "../core/git/conflicts.js";
import { getLog, getCommit, getBlame } from "../core/git/log.js";
import { stashList, stashSave, stashPop, stashDrop, stashShow } from "../core/git/stash.js";
import { bold, dim, heading, green, red, yellow, cyan } from "../cli/ui.js";

const USAGE_ERROR = 2;
const FAILURE = 1;

/** Resolve the workspace root to a validated GitContext, or return the error. */
export async function openWorkspace(target) {
  const ws = await validateWorkspace(target || process.cwd());
  if (!ws.ok) return { ok: false, error: ws.error, bare: ws.bare, root: ws.root };
  return {
    ok: true,
    ctx: new GitContext({ root: ws.root, gitVersion: ws.gitVersion, bare: ws.bare, worktree: ws.worktree }),
    root: ws.root,
    gitVersion: ws.gitVersion,
    bare: ws.bare,
    worktree: ws.worktree,
  };
}

function renderStatus(res) {
  const lines = [heading(`git status · ${res.branch.name || "(detached HEAD)"}`)];
  if (res.branch.upstream) {
    const track = [];
    if (res.branch.ahead) track.push(`ahead ${res.branch.ahead}`);
    if (res.branch.behind) track.push(`behind ${res.branch.behind}`);
    lines.push(dim(`${res.branch.upstream}${track.length ? ` (${track.join(", ")})` : ""}`));
  }
  const section = (label, items, fmt) => {
    if (!items.length) return;
    lines.push(bold(`${label} (${items.length})`));
    for (const it of items) lines.push(`  ${fmt(it)}`);
  };
  section("staged", res.staged, (e) => `${green(e.indexStatus)} ${e.path}`);
  section("unstaged", res.unstaged, (e) => `${yellow(e.workTreeStatus)} ${e.path}`);
  section("unmerged", res.unmerged, (e) => `${red(e.status)} ${e.path}`);
  section("untracked", res.untracked, (e) => `${dim("?")} ${e.path}`);
  if (!res.staged.length && !res.unstaged.length && !res.untracked.length && !res.unmerged.length) {
    lines.push(green("working tree clean"));
  }
  return lines.join("\n");
}

function renderLog(commits) {
  if (!commits.length) return dim("no commits");
  return commits
    .map((c) => `${cyan(c.shortHash)} ${dim(c.date.slice(0, 10))} ${c.author}: ${c.subject}`)
    .join("\n");
}

function renderBranches(branches, current) {
  if (!branches.length) return dim("no branches");
  return branches
    .map((b) => `${b.name === current ? green("*") : " "} ${b.isCurrent ? bold(b.name) : b.name}${b.upstream ? dim(` -> ${b.upstream}`) : ""}`)
    .join("\n");
}

function parseFlags(rest) {
  const flags = { _: [] };
  const words = [];
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq === -1) flags[body] = true;
      else flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (tok.startsWith("-") && tok.length === 2) {
      flags[tok.slice(1)] = true;
    } else {
      words.push(tok);
    }
  }
  flags._ = words;
  return flags;
}

/**
 * Run one git subcommand and return `{ ok, text, data }`.
 *
 * @param {import("../core/git/discover.js").GitContext} gc
 * @param {string} sub
 * @param {string[]} rest
 * @returns {Promise<{ ok: boolean, text: string, data: object }>}
 */
export async function dispatchGit(gc, sub, rest = []) {
  switch (sub) {
    case "status": {
      const res = await runStatus(gc);
      if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
      return { ok: true, text: renderStatus(res), data: res };
    }
    case "log": {
      const f = parseFlags(rest);
      const positional = Number(f._[0]) > 0 ? Number(f._[0]) : 0;
      const viaFlag = Number(f.limit) > 0 ? Number(f.limit) : 0;
      const limit = positional || viaFlag || 20;
      const res = await getLog(gc, { limit, path: f.path ? String(f.path) : undefined });
      if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
      return { ok: true, text: renderLog(res.commits), data: { commits: res.commits } };
    }
    case "diff": {
      const f = parseFlags(rest);
      const opts = { staged: !!f.staged, paths: f._.length ? f._ : undefined };
      if (f.stat) {
        const res = await diffStat(gc, opts);
        if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
        const text = res.files.length
          ? res.files.map((x) => `${x.binary ? "-" : x.additions}\t${x.binary ? "-" : x.deletions}\t${x.file}`).join("\n")
          : dim("no changes");
        return { ok: true, text, data: res };
      }
      const res = await runDiff(gc, opts);
      if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
      return { ok: true, text: res.raw.trim() || dim("no changes"), data: { raw: res.raw } };
    }
    case "branch": {
      const cur = await currentBranch(gc);
      const res = await listBranches(gc);
      if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
      return { ok: true, text: renderBranches(res.branches, cur.name), data: { branches: res.branches, current: cur.name } };
    }
    case "show": {
      const ref = rest[0] || "HEAD";
      const res = await getCommit(gc, ref);
      if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
      const meta = res.meta;
      const head = meta ? `${cyan(meta.shortHash)} ${meta.author} <${meta.authorEmail}>\n\n${bold(meta.subject)}\n\n${meta.body}` : "";
      return { ok: true, text: `${head}\n\n${res.diff}`.trim(), data: res };
    }
    case "blame": {
      const file = rest[0];
      if (!file) return { ok: false, text: red("blame requires a file"), data: { error: "missing path" } };
      const res = await getBlame(gc, file);
      if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
      const text = res.lines.map((l) => `${dim(l.hash.slice(0, 8))} ${l.author} ${l.line}: ${l.content}`).join("\n");
      return { ok: true, text, data: res };
    }
    case "stage":
    case "unstage": {
      if (!rest.length) return { ok: false, text: red(`${sub} requires at least one path`), data: { error: "missing path" } };
      const res = sub === "stage" ? await stageFiles(gc, rest) : await unstageFiles(gc, rest);
      if (!res.ok && !res.staged.length) return { ok: false, text: red(res.errors.join("; ")), data: res };
      const verb = sub === "stage" ? "staged" : "unstaged";
      const text = `${green(verb)} ${res.staged.join(", ")}${res.errors.length ? `\n${yellow(res.errors.join("; "))}` : ""}`;
      return { ok: res.ok, text, data: res };
    }
    case "commit": {
      const message = rest.join(" ").trim() || (await generateCommitMessage(gc));
      const res = await createCommit(gc, message);
      if (!res.ok) return { ok: false, text: red(res.error), data: res };
      return { ok: true, text: `${green("committed")} ${cyan(res.hash || "")} ${message.split("\n")[0]}`, data: { ...res, message } };
    }
    case "stash": {
      const action = rest[0] || "list";
      if (action === "list") {
        const res = await stashList(gc);
        if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
        const text = res.stashes.length ? res.stashes.map((s) => `${cyan(s.ref)} ${s.message}`).join("\n") : dim("no stashes");
        return { ok: true, text, data: { stashes: res.stashes } };
      }
      if (action === "save") {
        const res = await stashSave(gc, rest.slice(1).join(" ") || undefined);
        return res.ok ? { ok: true, text: `${green("saved")} ${cyan(res.ref)}`, data: res } : { ok: false, text: red(res.error), data: res };
      }
      if (action === "pop" || action === "drop") {
        const idx = rest[1] !== undefined ? Number(rest[1]) : undefined;
        const res = action === "pop" ? await stashPop(gc, idx) : await stashDrop(gc, idx);
        return res.ok ? { ok: true, text: `${green(action)} ${cyan(res.ref)}`, data: res } : { ok: false, text: red(res.error), data: res };
      }
      if (action === "show") {
        const res = await stashShow(gc, rest[1] !== undefined ? Number(rest[1]) : undefined);
        return res.ok ? { ok: true, text: res.diff.trim() || dim("empty stash"), data: res } : { ok: false, text: red(res.error), data: res };
      }
      return { ok: false, text: red(`unknown stash action: ${action}`), data: { error: "unknown action" } };
    }
    case "conflicts": {
      const action = rest[0] || "list";
      if (action === "list") {
        const res = await detectConflicts(gc);
        if (!res.ok) return { ok: false, text: red(res.error), data: { error: res.error } };
        const text = res.conflicts.length ? res.conflicts.map((c) => `${red(c.status)} ${c.path}`).join("\n") : green("no conflicts");
        return { ok: true, text, data: { conflicts: res.conflicts } };
      }
      if (action === "resolve") {
        const [p, resolution = "ours"] = rest.slice(1);
        if (!p) return { ok: false, text: red("resolve requires a path"), data: { error: "missing path" } };
        const res = await resolveConflict(gc, p, resolution);
        return res.ok ? { ok: true, text: `${green("resolved")} ${res.path}`, data: res } : { ok: false, text: red(res.error), data: res };
      }
      if (action === "abort") {
        const res = await abortMerge(gc);
        return res.ok ? { ok: true, text: green("merge aborted"), data: res } : { ok: false, text: red(res.error), data: res };
      }
      return { ok: false, text: red(`unknown conflicts action: ${action}`), data: { error: "unknown action" } };
    }
    default:
      return { ok: false, text: red(`unknown git subcommand: ${sub}`), data: { error: `unknown subcommand: ${sub}` } };
  }
}

/**
 * The chat `/git` handler: resolve the workspace, dispatch, and hand back text.
 *
 * @param {string} arg the text after `/git`
 * @param {{ root: string }} opts
 * @returns {Promise<string>}
 */
export async function gitSlash(arg, { root }) {
  const open = await openWorkspace(root);
  if (!open.ok) return red(open.error);
  const [sub = "status", ...rest] = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const result = await dispatchGit(open.ctx, sub, rest);
  return result.text;
}

export const gitCommand = defineCommand("git", {
  summary: "inspect and drive the repository: status, log, diff, branch, stage, commit, stash, conflicts",
  valueFlags: ["project", "path", "limit", "message"],
  usage: `aflow git [status] [--project PATH]
  aflow git log [N] [--path FILE]
  aflow git diff [--staged] [--stat] [path...]
  aflow git branch
  aflow git show [ref]
  aflow git blame <file>
  aflow git stage <path...>
  aflow git unstage <path...>
  aflow git commit [--message TEXT]
  aflow git stash [list|save|pop|show|drop] [N]
  aflow git conflicts [list|resolve <path> <ours|theirs|both>|abort]

Read-only inspection and the workflow writes that belong in a terminal. Nothing
here pushes, force-deletes, or rewrites history. Paths and branch names are
validated before anything reaches git.

Inside a chat, the same dispatcher is reachable as /git <subcommand>.

  --project PATH   operate on another repository
  --json           machine-readable output for the subcommands that have a shape

Exit codes: 0 ok, 1 a git failure, 2 usage.`,
  run: async ({ args, flags, out }) => {
    const [sub = "status", ...rest] = args || [];
    const project = flags && flags.project ? String(flags.project) : process.cwd();
    const open = await openWorkspace(project);
    if (!open.ok) {
      await out.init({ ok: false, error: open.error, bare: open.bare ?? false }, () => red(open.error));
      return FAILURE;
    }
    if (sub === "help" || sub === "--help") {
      await out.init({ usage: gitCommand.usage }, () => gitCommand.usage);
      return USAGE_ERROR;
    }
    // `--message` is delivered as a flag by the parser; fold it back into the
    // positional list so `commit --message "..."` and `commit "..."` are one path.
    const msg = flags && typeof flags.message === "string" ? flags.message : null;
    const withMessage = sub === "commit" && msg ? [msg, ...rest] : rest;
    // The router has already lifted every `--flag` out of the positionals, but
    // the dispatcher parses them from the token list (so the chat `/git` path,
    // which never sees a router, works the same way). Re-emit them here.
    const forwarded = [...withMessage];
    for (const [key, value] of Object.entries(flags || {})) {
      if (key === "project" || key === "message") continue;
      if (value === true) forwarded.push(`--${key}`);
      else if (typeof value === "string" && value) forwarded.push(`--${key}=${value}`);
    }
    const result = await dispatchGit(open.ctx, sub, forwarded);
    await out.init(result.data, () => result.text);
    return result.ok ? 0 : FAILURE;
  },
});

export default gitCommand;
