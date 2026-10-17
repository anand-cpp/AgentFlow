// Git tools for the agent registry.
//
// These are the only place a model reaches git. Each is a thin adapter over the
// `src/core/git` modules -- it resolves the workspace, builds a GitContext, calls
// the operation, and renders a bounded, redacted result. No tool checks a policy
// of its own: the waterfall in tools.js decides, exactly as for every other tool.
//
// Scopes: read-only inspection is READ; anything that writes the index, a branch,
// the working tree or history is WRITE. There is no dedicated git scope, so a
// model granted READ can inspect a repository but cannot change it.

import { GitContext, validateWorkspace } from "./discover.js";
import { runStatus } from "./status.js";
import { runDiff, parseDiff, diffStat } from "./diff.js";
import { stageFiles, unstageFiles, stageAll, unstageAll } from "./staging.js";
import { listBranches, currentBranch, createBranch, switchBranch, deleteBranch, renameBranch, validateBranchName, validateStartPoint } from "./branches.js";
import { createCommit, generateCommitMessage, validateCommitMessage } from "./commit.js";
import { detectConflicts, resolveConflict, abortMerge, isMergeInProgress } from "./conflicts.js";
import { getLog, getCommit, getBlame } from "./log.js";
import { stashList, stashSave, stashPop, stashApply, stashDrop, stashClear, stashShow } from "./stash.js";

import { TOOL_SCOPE } from "../agents/registry.js";
import { TOOL_ERROR, ToolInvocationError } from "../agents/tool-errors.js";
import { requireWorkspaceRoot } from "../agents/tool-paths.js";
import { boundOutput, DEFAULT_MAX_BYTES } from "../agents/tool-bounds.js";
import { redact } from "../redact.js";

/** Replace every credential-shaped substring in a result, wherever it sits. */
function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/** Bound and redact the human-readable rendering a tool hands back. */
function render(text, label) {
  return boundOutput(text, DEFAULT_MAX_BYTES, { label, redaction: redact });
}

/** Resolve the workspace root to a validated GitContext, or fail cleanly. */
async function gitContext(ctx) {
  const root = requireWorkspaceRoot(ctx);
  const ws = await validateWorkspace(root);
  if (!ws.ok) {
    throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, ws.error || "not a git repository", {
      root,
      bare: ws.bare,
    });
  }
  return new GitContext({ root: ws.root, gitVersion: ws.gitVersion, bare: ws.bare, worktree: ws.worktree });
}

function failFrom(result, what) {
  throw new ToolInvocationError(TOOL_ERROR.PROCESS_FAILED, `${what} failed: ${result.error}`, {});
}

const EVENTS = ["tool.call", "tool.denied", "tool.error"];

// ---------------------------------------------------------------------------
// git.status (read)
// ---------------------------------------------------------------------------

const statusTool = {
  name: "git.status",
  scope: TOOL_SCOPE.READ,
  description: "Show the working-tree status: branch, staged, unstaged, untracked and unmerged paths.",
  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      untracked: { type: "string", enum: ["normal", "all", "no"], description: "Untracked file reporting. Defaults to normal." },
    },
  },
  resultSchema: {
    type: "object",
    properties: {
      branch: { type: "object" },
      staged: { type: "array" },
      unstaged: { type: "array" },
      untracked: { type: "array" },
      unmerged: { type: "array" },
      clean: { type: "boolean" },
      output: { type: "string" },
    },
  },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const res = await runStatus(gc, { untracked: args.untracked });
    if (!res.ok) failFrom(res, "git status");
    const lines = [`On branch ${res.branch.name || "(detached)"}`];
    if (res.branch.upstream) lines.push(`  upstream: ${res.branch.upstream} (+${res.branch.ahead} -${res.branch.behind})`);
    for (const e of res.staged) lines.push(`  staged:   ${e.indexStatus} ${e.path}`);
    for (const e of res.unstaged) lines.push(`  unstaged: ${e.workTreeStatus} ${e.path}`);
    for (const e of res.unmerged) lines.push(`  unmerged: ${e.status} ${e.path}`);
    for (const p of res.untracked) lines.push(`  untracked: ${p.path}`);
    const clean = !res.staged.length && !res.unstaged.length && !res.untracked.length && !res.unmerged.length;
    if (clean) lines.push("  (clean)");
    const out = render(lines.join("\n"), "status");
    return redactDeep({
      branch: res.branch,
      staged: res.staged,
      unstaged: res.unstaged,
      untracked: res.untracked,
      unmerged: res.unmerged,
      clean,
      output: out.text,
    });
  },
};

// ---------------------------------------------------------------------------
// git.diff (read)
// ---------------------------------------------------------------------------

const diffTool = {
  name: "git.diff",
  scope: TOOL_SCOPE.READ,
  description: "Show changes as a unified diff, or as a per-file summary with --stat.",
  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      staged: { type: "boolean", description: "Diff the index against HEAD instead of the working tree." },
      ref: { type: "string", description: "Diff against this revision." },
      paths: { type: "array", items: { type: "string" }, description: "Limit to these workspace-relative paths." },
      contextLines: { type: "integer", minimum: 0, maximum: 100, description: "Unified context lines. Defaults to 3." },
      stat: { type: "boolean", description: "Return a per-file summary instead of the full patch." },
    },
  },
  resultSchema: {
    type: "object",
    properties: {
      files: { type: "array" },
      diff: { type: "string" },
      output: { type: "string" },
      truncated: { type: "boolean" },
    },
  },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const opts = { staged: args.staged, ref: args.ref, paths: args.paths, contextLines: args.contextLines };
    if (args.stat) {
      const res = await diffStat(gc, opts);
      if (!res.ok) failFrom(res, "git diff --numstat");
      const output = res.files.map((f) => `${f.additions}\t${f.deletions}\t${f.file ?? ""}`).join("\n");
      const out = render(output, "diff stat");
      return redactDeep({ files: res.files, diff: "", output: out.text, truncated: out.truncated });
    }
    const res = await runDiff(gc, opts);
    if (!res.ok) failFrom(res, "git diff");
    const files = parseDiff(res.raw ?? "");
    const text = res.raw ?? "";
    const out = render(text, "diff");
    return redactDeep({ files, diff: out.text, output: out.text, truncated: out.truncated });
  },
};

// ---------------------------------------------------------------------------
// git.log (read)
// ---------------------------------------------------------------------------

const logTool = {
  name: "git.log",
  scope: TOOL_SCOPE.READ,
  description: "Browse commit history with optional filters by path, author, date or message.",
  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum commits. Defaults to 20." },
      path: { type: "string", description: "Restrict to commits touching this path." },
      author: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      grep: { type: "string", description: "Only commits whose message matches." },
      ref: { type: "string", description: "Starting revision. Defaults to HEAD." },
    },
  },
  resultSchema: { type: "object", properties: { commits: { type: "array" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const res = await getLog(gc, {
      limit: args.limit ?? 20,
      path: args.path,
      author: args.author,
      since: args.since,
      until: args.until,
      grep: args.grep,
      ref: args.ref,
    });
    if (!res.ok) failFrom(res, "git log");
    const output = res.commits.map((c) => `${c.shortHash} ${c.date} ${c.author}: ${c.subject}`).join("\n");
    const out = render(output, "log");
    return redactDeep({ commits: res.commits, output: out.text });
  },
};

// ---------------------------------------------------------------------------
// git.show (read)
// ---------------------------------------------------------------------------

const showTool = {
  name: "git.show",
  scope: TOOL_SCOPE.READ,
  description: "Show one commit's metadata and, unless suppressed, its patch.",
  inputSchema: {
    type: "object",
    required: ["ref"],
    additionalProperties: false,
    properties: {
      ref: { type: "string", description: "Commit-ish to show." },
      diff: { type: "boolean", description: "Include the patch. Defaults to true." },
    },
  },
  resultSchema: { type: "object", properties: { meta: { type: "object" }, diff: { type: "string" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const res = await getCommit(gc, args.ref);
    if (!res.ok) failFrom(res, "git show");
    const withDiff = args.diff !== false;
    const header = res.meta ? `${res.meta.shortHash} ${res.meta.author} <${res.meta.authorEmail}> ${res.meta.date}\n\n${res.meta.subject}\n\n${res.meta.body}` : "";
    const out = render(withDiff ? `${header}\n\n${res.diff}` : header, "show");
    return redactDeep({ meta: res.meta, diff: withDiff ? out.text : "", output: out.text });
  },
};

// ---------------------------------------------------------------------------
// git.blame (read)
// ---------------------------------------------------------------------------

const blameTool = {
  name: "git.blame",
  scope: TOOL_SCOPE.READ,
  description: "Per-line attribution for a file.",
  inputSchema: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Workspace-relative file." },
      start: { type: "integer", minimum: 1 },
      end: { type: "integer", minimum: 1 },
    },
  },
  resultSchema: { type: "object", properties: { lines: { type: "array" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const res = await getBlame(gc, args.path, { start: args.start, end: args.end });
    if (!res.ok) failFrom(res, "git blame");
    const output = res.lines.map((l) => `${l.hash.slice(0, 8)} ${l.author} ${l.line}: ${l.content}`).join("\n");
    const out = render(output, "blame");
    return redactDeep({ lines: res.lines, output: out.text });
  },
};

// ---------------------------------------------------------------------------
// git.stage (write)
// ---------------------------------------------------------------------------

const stageTool = {
  name: "git.stage",
  scope: TOOL_SCOPE.WRITE,
  description: "Stage or unstage files, or the whole tree. Untracked-but-ignored files are never added implicitly.",
  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      files: { type: "array", items: { type: "string" }, description: "Workspace-relative paths. Ignored when all is true." },
      all: { type: "boolean", description: "Stage/unstage every change in the tree." },
      unstage: { type: "boolean", description: "Reverse the operation." },
      force: { type: "boolean", description: "Allow adding ignored files. Defaults to false." },
    },
  },
  resultSchema: { type: "object", properties: { staged: { type: "array" }, errors: { type: "array" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    let res;
    if (args.all) {
      res = args.unstage ? await unstageAll(gc) : await stageAll(gc, { force: args.force });
    } else {
      const files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "provide files, or all: true");
      res = args.unstage ? await unstageFiles(gc, files) : await stageFiles(gc, files, { force: args.force });
    }
    const out = render(`staged: ${(res.staged || []).join(", ") || "(none)"}${res.errors?.length ? `\nerrors: ${res.errors.join("; ")}` : ""}`, "stage");
    return redactDeep({ staged: res.staged || [], errors: res.errors || [], output: out.text });
  },
};

// ---------------------------------------------------------------------------
// git.branch (write)
// ---------------------------------------------------------------------------

const branchTool = {
  name: "git.branch",
  scope: TOOL_SCOPE.WRITE,
  description: "List, create, switch, rename or delete branches. Deleting the current branch is refused.",
  inputSchema: {
    type: "object",
    required: ["action"],
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "create", "switch", "delete", "rename"] },
      name: { type: "string", description: "Branch to create, switch to, delete or rename." },
      from: { type: "string", description: "Start point for create." },
      newName: { type: "string", description: "New name for rename." },
      force: { type: "boolean", description: "Force delete / force create." },
    },
  },
  resultSchema: { type: "object", properties: { branches: { type: "array" }, ok: { type: "boolean" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const action = args.action;
    if (action === "list") {
      const cur = await currentBranch(gc);
      const res = await listBranches(gc);
      if (!res.ok) failFrom(res, "git branch");
      const output = res.branches.map((b) => `${b.name === cur.name ? "*" : " "} ${b.name}${b.upstream ? ` -> ${b.upstream}` : ""}`).join("\n");
      const out = render(output, "branch list");
      return redactDeep({ branches: res.branches, current: cur.name, ok: true, output: out.text });
    }
    if (action === "create") {
      const v = validateBranchName(args.name);
      if (!v.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, v.error);
      if (args.from !== undefined && args.from !== null && args.from !== "") {
        const s = validateStartPoint(args.from);
        if (!s.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, s.error);
      }
      const res = await createBranch(gc, args.name, args.from);
      if (!res.ok) failFrom(res, "git branch create");
      return redactDeep({ ok: true, branch: res.name, output: `created ${res.name}` });
    }
    if (action === "switch") {
      const v = validateBranchName(args.name);
      if (!v.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, v.error);
      const res = await switchBranch(gc, args.name);
      if (!res.ok) failFrom(res, "git switch");
      return redactDeep({ ok: true, branch: res.name, output: `switched to ${res.name}` });
    }
    if (action === "delete") {
      const v = validateBranchName(args.name);
      if (!v.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, v.error);
      const res = await deleteBranch(gc, args.name, !!args.force);
      if (!res.ok) failFrom(res, "git branch delete");
      return redactDeep({ ok: true, branch: res.name, output: `deleted ${res.name}` });
    }
    if (action === "rename") {
      const from = validateBranchName(args.name);
      const to = validateBranchName(args.newName);
      if (!from.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, from.error);
      if (!to.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, to.error);
      const res = await renameBranch(gc, args.name, args.newName);
      if (!res.ok) failFrom(res, "git branch rename");
      return redactDeep({ ok: true, branch: res.name, output: `renamed to ${res.name}` });
    }
    throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, `unknown branch action: ${action}`);
  },
};

// ---------------------------------------------------------------------------
// git.commit (write)
// ---------------------------------------------------------------------------

const commitTool = {
  name: "git.commit",
  scope: TOOL_SCOPE.WRITE,
  description:
    "Create a commit from the staged changes. When no message is given, a conventional message is generated from the staged diff.",
  inputSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      message: { type: "string", description: "Commit message. Generated from the staged diff when omitted." },
      all: { type: "boolean", description: "Stage tracked modifications first (git commit -a)." },
      amend: { type: "boolean", description: "Amend the previous commit." },
      signoff: { type: "boolean", description: "Add a Signed-off-by trailer." },
    },
  },
  resultSchema: { type: "object", properties: { hash: { type: "string" }, message: { type: "string" }, warnings: { type: "array" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    let message = args.message;
    if (!message) {
      // With `all`, `commit -a` has not staged anything yet, so the index is
      // empty and the staged-diff heuristic would see nothing. Diff against HEAD
      // instead, which is what `-a` would capture.
      const diff = args.all ? await gc.run(["diff", "HEAD", "--no-color"]) : null;
      message = await generateCommitMessage(gc, diff && diff.ok ? diff.stdout : undefined);
    }
    const check = validateCommitMessage(message);
    if (!check.ok) throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, check.errors.join("; "), {});
    const res = await createCommit(gc, message, { all: args.all, amend: args.amend, signoff: args.signoff });
    if (!res.ok) failFrom(res, "git commit");
    const out = render(`committed ${res.hash}: ${message.split("\n")[0]}`, "commit");
    return redactDeep({ hash: res.hash, message, warnings: res.warnings || [], output: out.text });
  },
};

// ---------------------------------------------------------------------------
// git.stash (write)
// ---------------------------------------------------------------------------

const stashTool = {
  name: "git.stash",
  scope: TOOL_SCOPE.WRITE,
  description: "List, create, apply, pop, drop, show or clear stashes.",
  inputSchema: {
    type: "object",
    required: ["action"],
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "save", "apply", "pop", "drop", "show", "clear"] },
      message: { type: "string", description: "Message for save." },
      index: { type: "integer", minimum: 0, description: "Stash index. Defaults to the most recent (0)." },
      includeUntracked: { type: "boolean", description: "Include untracked files on save." },
      keepIndex: { type: "boolean", description: "Keep the index intact on save." },
    },
  },
  resultSchema: { type: "object", properties: { stashes: { type: "array" }, ok: { type: "boolean" }, diff: { type: "string" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const action = args.action;
    if (action === "list") {
      const res = await stashList(gc);
      if (!res.ok) failFrom(res, "git stash list");
      const output = res.stashes.map((s) => `${s.ref}: ${s.message}`).join("\n");
      const out = render(output || "(no stashes)", "stash list");
      return redactDeep({ stashes: res.stashes, ok: true, output: out.text });
    }
    if (action === "save") {
      const res = await stashSave(gc, args.message, { includeUntracked: args.includeUntracked, keepIndex: args.keepIndex });
      if (!res.ok) failFrom(res, "git stash push");
      return redactDeep({ ok: true, ref: res.ref, hash: res.hash, output: `saved ${res.ref}` });
    }
    if (action === "apply" || action === "pop" || action === "drop") {
      const fn = action === "apply" ? stashApply : action === "pop" ? stashPop : stashDrop;
      const res = await fn(gc, args.index);
      if (!res.ok) failFrom(res, `git stash ${action}`);
      return redactDeep({ ok: true, ref: res.ref, output: `${action}ed ${res.ref}` });
    }
    if (action === "show") {
      const res = await stashShow(gc, args.index);
      if (!res.ok) failFrom(res, "git stash show");
      const out = render(res.diff, "stash show");
      return redactDeep({ ok: true, ref: res.ref, diff: out.text, output: out.text });
    }
    if (action === "clear") {
      const res = await stashClear(gc);
      if (!res.ok) failFrom(res, "git stash clear");
      return redactDeep({ ok: true, output: "cleared stashes" });
    }
    throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, `unknown stash action: ${action}`);
  },
};

// ---------------------------------------------------------------------------
// git.conflicts (write)
// ---------------------------------------------------------------------------

const conflictsTool = {
  name: "git.conflicts",
  scope: TOOL_SCOPE.WRITE,
  description: "List merge conflicts, resolve one by strategy or content, or abort the in-progress merge.",
  inputSchema: {
    type: "object",
    required: ["action"],
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "resolve", "abort"] },
      path: { type: "string", description: "Conflicted path to resolve." },
      resolution: { type: "string", description: '"ours", "theirs", "both", or literal replacement content.' },
    },
  },
  resultSchema: { type: "object", properties: { conflicts: { type: "array" }, ok: { type: "boolean" }, output: { type: "string" } } },
  events: EVENTS,

  async execute(args = {}, ctx = {}) {
    const gc = await gitContext(ctx);
    const action = args.action;
    if (action === "list") {
      const res = await detectConflicts(gc);
      if (!res.ok) failFrom(res, "git status");
      const inProgress = await isMergeInProgress(gc);
      const output = res.conflicts.map((c) => `${c.status} ${c.path}`).join("\n") || "(no conflicts)";
      const out = render(output, "conflicts");
      return redactDeep({ conflicts: res.conflicts, mergeInProgress: inProgress, ok: true, output: out.text });
    }
    if (action === "resolve") {
      if (!args.path || args.resolution == null) {
        throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "resolve requires path and resolution");
      }
      const res = await resolveConflict(gc, args.path, args.resolution);
      if (!res.ok) failFrom(res, "git conflict resolve");
      return redactDeep({ ok: true, path: res.path, output: `resolved ${res.path}` });
    }
    if (action === "abort") {
      const res = await abortMerge(gc);
      if (!res.ok) failFrom(res, "git merge --abort");
      return redactDeep({ ok: true, output: "aborted merge" });
    }
    throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, `unknown conflicts action: ${action}`);
  },
};

export const gitTools = [
  statusTool,
  diffTool,
  logTool,
  showTool,
  blameTool,
  stageTool,
  branchTool,
  commitTool,
  stashTool,
  conflictsTool,
];

export const GIT_TOOL_NAMES = gitTools.map((t) => t.name);

export default { gitTools, GIT_TOOL_NAMES };
