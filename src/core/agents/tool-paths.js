// Workspace containment for the real tools.
//
// tools.js does lexical containment for its allowlists and says so plainly:
//
//   "Honest limit: this is lexical, so it does not follow symlinks or Windows
//    junctions. Containment against a real filesystem needs `fs.realpath`,
//    which belongs in the tool that touches the filesystem rather than here --
//    but the tool must still do it. Lexical resolution is not a substitute."
//
// This is that. Every tool that takes a path from a model runs it through
// `resolveInWorkspace` first.
//
// The rule being enforced is one sentence: a path handed to a tool may only
// reach bytes the workspace root can already reach. There are two ways to break
// that, and they need different defences.
//
//   `../../etc/passwd`  -- defeats a naive prefix test, because the *string*
//                          still starts with the root. Caught lexically, before
//                          the filesystem is touched at all.
//
//   link/secret.txt     -- where `link` is a symlink or a Windows junction to
//                          `/etc`. Every segment is innocent. Only realpath
//                          resolution sees it, and `path.lexical` says the path
//                          is fine, so a tool that checked only lexically would
//                          happily hand over `/etc/passwd`.
//
// Both are checked, in that order, and lexical first because it is free.
//
// Why the nearest existing ancestor: a write target usually does not exist yet,
// so there is nothing to realpath. But its *parent* does, and the parent is
// exactly where an escape hides -- `link/newfile.txt` where `link` points out of
// the tree. So resolve the deepest ancestor that exists, and re-attach the rest.

import fs from "node:fs";
import path from "node:path";

import { TOOL_ERROR, ToolInvocationError } from "./tool-errors.js";

/**
 * Is `child` inside `parent`, by path segment?
 *
 * Segment-based, never `startsWith`: `/work/project-secrets` starts with the
 * string `/work/project` but is a different directory. `path.relative` is used
 * rather than manual splitting so Windows separators and drive letters are
 * handled by the platform instead of by a regex here.
 */
export function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === "") return true; // the root itself
  if (path.isAbsolute(rel)) return false; // a different drive/root entirely
  return !rel.startsWith("..") && rel !== "..";
}

/**
 * realpath the deepest existing ancestor of `abs`, then re-attach the remainder.
 *
 * Returns the real location `abs` would occupy once created. For a path that
 * already exists this is just `realpath(abs)`.
 *
 * The walk stops at the first segment that is missing from disk. Anything above
 * that is irrelevant: a path cannot be created if its parent does not exist, and
 * resolving further up would only tell us something we already know.
 */
function realpathWithMissingTail(abs) {
  const tail = [];
  let current = abs;

  for (;;) {
    try {
      const real = fs.realpathSync.native
        ? fs.realpathSync.native(current)
        : fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      // Hit the filesystem root without finding anything that exists.
      if (parent === current) return abs;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `candidate` against `root`, refusing anything that leaves it.
 *
 * `candidate` may be relative (resolved against the root, which is what a model
 * means by "src/index.js") or absolute. Absolute is not privileged: it still has
 * to land inside the root, so an agent cannot reach `C:\Users\anand\.ssh` by
 * spelling it out.
 *
 * Returns `{ rootReal, requested, resolved }` where `resolved` is the real
 * location -- symlinks already followed -- and is what the caller must use.
 * Using `resolved` rather than `requested` is not an optimisation: it closes the
 * window between checking and opening, where the path could be swapped for a
 * link.
 *
 * Throws `ToolInvocationError(PATH_OUTSIDE_WORKSPACE)` for every escape.
 */
export function resolveInWorkspace(root, candidate, { label = "path" } = {}) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, `${label} must be a non-empty string`);
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "workspace root does not exist", { root });
    }
    throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, `workspace root is not usable: ${err?.code || "unknown"}`, { root });
  }

  const requested = path.resolve(rootReal, candidate);

  // Lexical first: cheap, and it stops `..` before we touch the filesystem.
  if (!isWithin(rootReal, requested)) {
    throw new ToolInvocationError(TOOL_ERROR.PATH_OUTSIDE_WORKSPACE, `${label} resolves outside the workspace`, {
      requested,
      rootReal,
    });
  }

  // Then real, which is the only thing that sees links.
  const resolved = realpathWithMissingTail(requested);
  if (!isWithin(rootReal, resolved)) {
    throw new ToolInvocationError(TOOL_ERROR.PATH_OUTSIDE_WORKSPACE, `${label} leaves the workspace through a link`, {
      requested,
      rootReal,
    });
  }

  return { rootReal, requested, resolved };
}

/**
 * Resolve the workspace root for a tool call.
 *
 * The root is not a tool argument. A model that could name its own root could
 * name `/` and be granted the whole filesystem, so it comes from the invocation
 * the operator controls.
 */
export function requireWorkspaceRoot(ctx) {
  const root = ctx?.workspaceRoot ?? ctx?.workspace ?? ctx?.root;
  if (typeof root !== "string" || root.trim() === "") {
    throw new ToolInvocationError(
      TOOL_ERROR.INVALID_INPUT,
      "no workspace root was configured for this tool invocation",
    );
  }
  return root;
}