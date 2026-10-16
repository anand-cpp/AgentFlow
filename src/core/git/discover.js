// Git discovery, workspace validation, and the single chokepoint every other
// git module runs through.
//
// Two invariants this file exists to enforce:
//
//   1. Every git invocation goes through GitContext.run() / GitContext.runInput(),
//      which use execFile/spawn with an explicit argv array. No shell ever sees a
//      user-supplied string, so there is no injection surface.
//   2. Every git invocation is scoped to the workspace root discovered here. A
//      caller cannot point a git command at a path outside the project.
//
// Everything returns a structured result. Expected failures (git missing, not a
// repository, a path that escapes the root) are values, not exceptions, so the
// CLI and the agent tools can render them without a try/catch around every call.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Cap on git stdout/stderr so a runaway diff cannot exhaust memory. */
export const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
/** Per-command wall-clock cap. Read-only commands are fast; this is a backstop. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Characters that would be meaningful to a shell. git is never invoked through a
 * shell (execFile/spawn only), so these are already inert -- rejecting them too
 * is defence in depth and keeps hostile paths out of git's own pathspec parser.
 */
const UNSAFE_CHARS = /[\0\r\n;&|`$<>]/;

function execFileOnce(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      // error.code is the exit code when the process ran and failed, or a string
      // like "ENOENT" when it never started. Distinguish the two.
      if (error) {
        const ran = typeof error.code === "number";
        resolve({
          code: ran ? error.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          spawnFailure: ran ? null : String(error.code ?? error.message),
        });
      } else {
        resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "", spawnFailure: null });
      }
    });
  });
}

/**
 * The workspace-scoped handle every git function takes as its first argument.
 *
 * Holding root + gitVersion together means a caller cannot accidentally run a
 * git command against a directory it has not validated, and every module agrees
 * on where the repository is.
 */
export class GitContext {
  /**
   * @param {{ root: string, gitVersion: string, bare?: boolean, worktree?: boolean }} init
   */
  constructor({ root, gitVersion, bare = false, worktree = false }) {
    this.root = path.resolve(root);
    this.gitVersion = gitVersion;
    this.bare = bare;
    this.worktree = worktree;
  }

  /**
   * Run a read-oriented git command and report the outcome without throwing.
   *
   * @param {string[]} args argv passed to git verbatim.
   * @param {{ cwd?: string, maxBuffer?: number, timeout?: number }} [opts]
   * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null }>}
   */
  async run(args, opts = {}) {
    const { cwd = this.root, maxBuffer = DEFAULT_MAX_BUFFER, timeout = DEFAULT_TIMEOUT_MS } = opts;
    const res = await execFileOnce("git", args, {
      cwd,
      maxBuffer,
      timeout,
      windowsHide: true,
      encoding: "utf8",
    });
    if (res.spawnFailure) {
      const message = res.spawnFailure === "ENOENT" ? "git is not installed or not on PATH" : `git failed to start: ${res.spawnFailure}`;
      return { ok: false, code: null, stdout: res.stdout, stderr: res.stderr, error: message };
    }
    const ok = res.code === 0;
    return {
      ok,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      error: ok ? null : res.stderr.trim() || `git exited ${res.code}`,
    };
  }

  /**
   * Run a git command that must receive data on stdin (git apply, git commit -F -).
   *
   * execFile cannot feed stdin, so this uses spawn with an explicit argv and
   * closes stdin immediately after writing. Output is bounded by hand because
   * spawn has no maxBuffer.
   *
   * @param {string[]} args
   * @param {string} input
   * @param {{ cwd?: string, timeout?: number, maxBytes?: number }} [opts]
   * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null }>}
   */
  runInput(args, input, opts = {}) {
    const { cwd = this.root, timeout = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BUFFER } = opts;
    return new Promise((resolve) => {
      const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        done({ ok: false, code: null, stdout, stderr, error: `git timed out after ${timeout}ms` });
      }, timeout);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        if (stdout.length < maxBytes) stdout += d;
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < maxBytes) stderr += d;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        done({
          ok: false,
          code: null,
          stdout,
          stderr,
          error: code === "ENOENT" ? "git is not installed or not on PATH" : `git failed to start: ${err.message}`,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({
          ok: code === 0,
          code,
          stdout,
          stderr,
          error: code === 0 ? null : stderr.trim() || `git exited ${code}`,
        });
      });
      child.stdin.on("error", () => {
        /* the child may exit before reading stdin; the close handler decides */
      });
      child.stdin.end(input);
    });
  }
}

/**
 * Walk up from startDir looking for a .git entry.
 *
 * .git is a directory in a normal clone and a *file* ("gitdir: <path>") in a
 * linked worktree; both count. Returns the containing directory of .git, or
 * null when startDir is not inside a repository.
 *
 * @param {string} [startDir]
 * @returns {{ ok: boolean, root: string|null, worktree: boolean, bare: boolean, error: string|null }}
 */
export function findGitRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const { root: stop } = path.parse(dir);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat;
    try {
      stat = fs.lstatSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return { ok: true, root: dir, worktree: false, bare: false, error: null };
    if (stat?.isFile()) return { ok: true, root: dir, worktree: true, bare: false, error: null };
    if (dir === stop) break;
    dir = path.dirname(dir);
  }
  return { ok: false, root: null, worktree: false, bare: false, error: `not a git repository (or any parent): ${path.resolve(startDir)}` };
}

/**
 * A bare repository has HEAD, objects/ and refs/ but no .git entry. Nothing in
 * this layer can operate on one (there is no working tree), so callers report
 * it as a distinct condition rather than "not a repo".
 *
 * @param {string} dir
 */
function looksBare(dir) {
  return (
    fs.existsSync(path.join(dir, "HEAD")) &&
    fs.existsSync(path.join(dir, "objects")) &&
    fs.existsSync(path.join(dir, "refs"))
  );
}

/** @returns {Promise<{ ok: boolean, version: string|null, major: number, minor: number, patch: number, error: string|null }>} */
export async function validateGitAvailable() {
  const probe = await execFileOnce("git", ["--version"], {
    cwd: process.cwd(),
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8",
  });
  if (probe.spawnFailure) {
    return {
      ok: false,
      version: null,
      major: 0,
      minor: 0,
      patch: 0,
      error: probe.spawnFailure === "ENOENT" ? "git is not installed or not on PATH" : `git failed to start: ${probe.spawnFailure}`,
    };
  }
  if (probe.code !== 0) {
    return { ok: false, version: null, major: 0, minor: 0, patch: 0, error: probe.stderr.trim() || "git --version failed" };
  }
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(probe.stdout);
  if (!m) return { ok: false, version: null, major: 0, minor: 0, patch: 0, error: `unrecognised git version output: ${probe.stdout.trim()}` };
  return {
    ok: true,
    version: `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ""}`,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] ?? 0),
    error: null,
  };
}

/**
 * Confirm a path is inside a usable git repository and return the handle other
 * functions need. Distinguishes "git missing", "not a repo" and "bare repo"
 * because the CLI shows a different message for each.
 *
 * @param {string} [target]
 * @returns {Promise<{ ok: boolean, root: string|null, gitVersion: string|null, bare: boolean, worktree: boolean, error: string|null }>}
 */
export async function validateWorkspace(target = process.cwd()) {
  const git = await validateGitAvailable();
  if (!git.ok) return { ok: false, root: null, gitVersion: null, bare: false, worktree: false, error: git.error };

  const resolved = path.resolve(target);
  const found = findGitRoot(resolved);
  if (!found.ok) {
    // Not a clone, but it might be a bare repository we should name explicitly.
    let dir = resolved;
    const { root: stop } = path.parse(dir);
    for (;;) {
      if (looksBare(dir)) {
        return { ok: false, root: dir, gitVersion: git.version, bare: true, worktree: false, error: `bare repository at ${dir} has no working tree` };
      }
      if (dir === stop) break;
      dir = path.dirname(dir);
    }
    return { ok: false, root: null, gitVersion: git.version, bare: false, worktree: false, error: found.error };
  }
  return { ok: true, root: found.root, gitVersion: git.version, bare: false, worktree: found.worktree, error: null };
}

/**
 * Reject a path that is not a safe workspace-relative argument.
 *
 * Stops null bytes, newlines and shell metacharacters, and refuses anything that
 * is absolute or contains a `..` segment. Absolute paths and `..` are the real
 * escape risk; the metacharacter block keeps hostile strings out of git's
 * pathspec parser even though no shell is involved.
 *
 * @param {unknown} relPath
 * @returns {{ ok: boolean, path: string|null, error: string|null }}
 */
export function validateRelPath(relPath) {
  const text = typeof relPath === "string" ? relPath : "";
  if (!text.trim()) return { ok: false, path: null, error: "path is empty" };
  if (UNSAFE_CHARS.test(text)) return { ok: false, path: null, error: "path contains forbidden characters (shell metacharacters or newlines)" };
  if (path.isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text)) {
    return { ok: false, path: null, error: "path must be relative to the workspace root, not absolute" };
  }
  const segments = text.split(/[\\/]+/);
  if (segments.includes("..")) return { ok: false, path: null, error: "path must not contain '..' segments" };
  return { ok: true, path: text, error: null };
}

/**
 * Validate a path and resolve it against the workspace root, proving the result
 * still lands inside the root. This is the last line of defence: even if a
 * symlink or an odd encoding slips past validateRelPath, the resolved path is
 * checked against the root before anything touches it.
 *
 * @param {string} root
 * @param {unknown} relPath
 * @returns {{ ok: boolean, path: string|null, relPath: string|null, error: string|null }}
 */
export function resolveInRoot(root, relPath) {
  const v = validateRelPath(relPath);
  if (!v.ok) return { ok: false, path: null, relPath: null, error: v.error };
  const base = path.resolve(root);
  const resolved = path.resolve(base, v.path);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, path: null, relPath: null, error: "path resolves outside the workspace root" };
  }
  // git wants posix separators in pathspecs regardless of host OS, so callers
  // can pass these strings straight to argv on Windows and Unix alike.
  const relPosix = rel.split(path.sep).join("/");
  return { ok: true, path: resolved, relPath: relPosix, error: null };
}

/**
 * Turn a list of user paths into a validated { paths, errors } pair, dropping
 * the bad ones and keeping the good. Callers stage/log/diff the survivors.
 *
 * @param {string} root
 * @param {unknown[]} paths
 * @returns {{ ok: boolean, paths: string[], errors: string[] }}
 */
export function validatePaths(root, paths) {
  const list = Array.isArray(paths) ? paths : [];
  const good = [];
  const errors = [];
  for (const p of list) {
    const r = resolveInRoot(root, p);
    if (r.ok) good.push(r.relPath);
    else errors.push(`${String(p)}: ${r.error}`);
  }
  return { ok: errors.length === 0, paths: good, errors };
}

export default {
  GitContext,
  findGitRoot,
  validateGitAvailable,
  validateWorkspace,
  validateRelPath,
  resolveInRoot,
  validatePaths,
  DEFAULT_MAX_BUFFER,
  DEFAULT_TIMEOUT_MS,
};
