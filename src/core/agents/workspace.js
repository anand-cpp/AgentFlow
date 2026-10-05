// Where a run's tools are allowed to touch.
//
// Every real tool refuses to act without a workspace root, and it has to be the
// *same* root for every call in a run. That sounds trivial and is not: the value
// arrives from a flag, from the process working directory, or from the project a
// session belongs to, and those three disagree in ways that only show up later --
// on a second machine, under a symlinked checkout, or when a session is resumed
// from a different directory.
//
// So resolution happens exactly once, up front, and the result is frozen. The
// alternative -- resolving per tool call -- means the answer depends on when the
// call happened, which makes "the agent stayed inside the workspace" a claim
// nobody can check after the fact.
//
// A run cannot move its own root. That is enforced here rather than by
// convention: `root` is a non-writable, non-configurable property, so a lifecycle
// hook, a pre-execute transform or a tool body that tries to re-point the
// workspace at /etc or a parent directory gets a TypeError instead of a
// capability. An agent that can choose its own blast radius is not a bounded
// agent.

import fs from "node:fs";
import path from "node:path";

import { TOOL_ERROR, ToolInvocationError } from "./tool-errors.js";

/** Why a root was chosen, kept for the receipt so a run is explainable later. */
export const ROOT_SOURCE = {
  EXPLICIT: "explicit",
  PROJECT: "project",
  CWD: "cwd",
};

export class WorkspaceError extends ToolInvocationError {
  constructor(message, code, details) {
    super(code, message, details);
    this.name = "WorkspaceError";
  }
}

/**
 * The one true path, resolved through every layer the OS can hide behind.
 *
 * `path.resolve` collapses `..` lexically, which is not the same question as
 * "where does this actually live". A checkout reached through a symlink has two
 * answers, and the lexical one is the one that will not match what a containment
 * check computes from `realpath` later. Resolving to the physical path once, here,
 * means the value every tool compares against is already canonical.
 *
 * Windows junctions resolve through realpath the same way, which is why this is
 * one implementation rather than a per-platform special case.
 */
function physicalPath(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Resolve and validate a candidate root, without wrapping it.
 *
 * Precedence is explicit > project > cwd, and it is fixed rather than
 * "whichever is set", because a flag that silently loses to an inherited project
 * root is how someone ends up editing a different checkout than the one they
 * named. A named root always wins, because naming one is the more specific
 * statement of intent.
 *
 * Throws rather than defaulting. Every fallback here would be a guess, and a
 * guessed workspace root is a guessed blast radius.
 *
 * Private to this module on purpose: callers get a `WorkspaceRoot`, so there is one
 * shape for a resolved root in the system rather than a bare object here and a
 * frozen holder there. Two shapes means every consumer has to guess which one it
 * was handed, and the one that guessed wrong silently loses the immutability.
 */
function resolveDescriptor({ explicit = null, projectRoot = null, cwd = process.cwd() } = {}) {
  const candidates = [
    { source: ROOT_SOURCE.EXPLICIT, value: explicit },
    { source: ROOT_SOURCE.PROJECT, value: projectRoot },
    { source: ROOT_SOURCE.CWD, value: cwd },
  ];

  const chosen = candidates.find((c) => typeof c.value === "string" && c.value.trim() !== "");
  if (!chosen) {
    throw new WorkspaceError(
      "no workspace root: pass --workspace, or run from a directory",
      TOOL_ERROR.INVALID_INPUT,
    );
  }

  // Resolved first so the existence check below reports the path the user typed
  // rather than a mangled relative version of it.
  const requested = path.resolve(String(chosen.value));
  let stats;
  try {
    stats = fs.statSync(requested);
  } catch (err) {
    throw new WorkspaceError(
      `workspace root does not exist: ${requested}`,
      TOOL_ERROR.INVALID_INPUT,
      { path: requested, source: chosen.source, cause: err?.code || null },
    );
  }
  if (!stats.isDirectory()) {
    // A file is a plausible typo and an outright dangerous default: every tool
    // would then resolve paths relative to something that is not a directory,
    // and the containment check would be comparing against nonsense.
    throw new WorkspaceError(
      `workspace root is not a directory: ${requested}`,
      TOOL_ERROR.INVALID_INPUT,
      { path: requested, source: chosen.source },
    );
  }

  const real = physicalPath(requested);
  return Object.freeze({
    root: real,
    requested,
    source: chosen.source,
    // Recorded so the receipt can say "you asked for /link, we resolved to
    // /real" instead of leaving a reader to wonder why the path changed.
    linked: real !== requested,
  });
}

/**
 * A frozen holder for one run's workspace root.
 *
 * Frozen at construction and not settable afterwards. `Object.defineProperty`
 * with `configurable: false` is doing the work here: a plain property would be
 * silently reassignable by anything holding a reference, and "the root cannot
 * change mid-run" is a security property, not a style preference.
 */
export class WorkspaceRoot {
  constructor(input = {}) {
    const resolved = resolveDescriptor(input);
    Object.defineProperty(this, "_resolved", {
      value: resolved,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(this, "root", {
      get: () => resolved.root,
      enumerable: true,
    });
    Object.defineProperty(this, "source", {
      get: () => resolved.source,
      enumerable: true,
    });
    Object.freeze(this);
  }

  /** The receipt half: safe to show a user, safe to persist. */
  describe() {
    return this._resolved;
  }

  /**
   * The tool-context shape.
   *
   * A copy rather than the holder, because `runTool` spreads its context into
   * tool bodies and pre-execute steps. Handing out a fresh object means a step
   * that scribbles on `ctx.workspaceRoot` cannot reach the run's root, even
   * though it could not have reached `this.root` either.
   */
  toolContext(extra = {}) {
    return { workspaceRoot: this._resolved.root, ...extra };
  }
}

/**
 * Resolve a workspace root. Returns a frozen `WorkspaceRoot`.
 *
 * The public entry point. Named as a function rather than only as a constructor
 * because callers overwhelmingly want to say "resolve these inputs" and read like
 * it -- `new WorkspaceRoot(...)` next to `resolveWorkspaceRoot(...)` in the same
 * codebase invites the belief that they do different things.
 */
export function resolveWorkspaceRoot(input = {}) {
  return new WorkspaceRoot(input);
}

/**
 * Resolve from CLI-shaped input, tolerating absence.
 *
 * `aflow agent list` and `aflow agent show` are read-only and must keep working
 * in a directory that is not a usable workspace -- or with no `--workspace` at
 * all. Only `run` requires a root, so the failure is returned to the caller as a
 * null rather than thrown here.
 */
export function tryResolveWorkspace(input = {}) {
  try {
    return new WorkspaceRoot(input);
  } catch {
    return null;
  }
}

export default { WorkspaceRoot, WorkspaceError, ROOT_SOURCE, resolveWorkspaceRoot, tryResolveWorkspace };
