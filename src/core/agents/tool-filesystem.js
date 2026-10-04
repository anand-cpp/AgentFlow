// filesystem.read, filesystem.write, filesystem.search.
//
// Three real tools over one filesystem, sharing the containment rules in
// tool-paths.js. Each declares its permission scope, so the existing waterfall
// in tools.js decides whether it may run at all -- none of them checks a policy
// of its own, because a tool that carries its own opinion about what is allowed
// is a second permission system, and two answers to "may I read this" is one
// too many.
//
// What they *do* own is the filesystem truth the waterfall cannot know: whether a
// path is inside the workspace once symlinks are followed, whether a file is
// binary, and how big it is.

import fs from "node:fs";
import path from "node:path";

import { TOOL_SCOPE } from "./registry.js";
import { TOOL_ERROR, ToolInvocationError, fromSystemError } from "./tool-errors.js";
import { resolveInWorkspace, requireWorkspaceRoot, isWithin } from "./tool-paths.js";
import { boundOutput, boundList, enforceByteLimit, DEFAULT_MAX_BYTES } from "./tool-bounds.js";
import { redact } from "../redact.js";

/** A file larger than this is refused, not truncated. See `enforceByteLimit`. */
export const MAX_READ_BYTES = 1024 * 1024;

/** A single write larger than this is refused. One agent turn should not be able
 *  to materialise an arbitrarily large file inside the workspace. */
export const MAX_WRITE_BYTES = 4 * 1024 * 1024;

/** Search walks at most this much, so a huge tree cannot stall a run. */
export const MAX_SEARCH_BYTES = 64 * 1024 * 1024;

/** Directories never walked. Build output and dependencies are large, binary,
 *  and regenerated; searching them is never what a model meant. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".venv", "__pycache__"]);

/**
 * Is this buffer binary?
 *
 * Counts NUL bytes in the first 8KB, which is how git decides. A leading NUL is
 * treated as decisive on its own, because a NUL in byte 0 means this is not text
 * under any encoding worth guessing.
 */
export function looksBinary(buf) {
  const window = buf.subarray(0, 8192);
  if (window.length && window[0] === 0) return true;
  let nul = 0;
  for (const byte of window) if (byte === 0) nul += 1;
  return nul / Math.max(1, window.length) > 0.3;
}

function statOrFail(target, what) {
  try {
    return fs.statSync(target);
  } catch (err) {
    throw fromSystemError(err, what);
  }
}

// ---------------------------------------------------------------------------
// filesystem.read
// ---------------------------------------------------------------------------

export const readTool = {
  name: "filesystem.read",
  scope: TOOL_SCOPE.READ,
  description:
    "Read a UTF-8 text file inside the workspace. Refuses directories, binary files and anything over 1MB.",
  inputSchema: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Workspace-relative path. Absolute paths are allowed only if they land inside the workspace." },
      maxBytes: { type: "integer", minimum: 1, maximum: MAX_READ_BYTES, description: "Output bound. Defaults to 256KB." },
    },
  },
  // Stated rather than left implicit. A caller reading only the description cannot
  // otherwise tell that a 1MB+ file is an error and a 256KB+ file is a prefix with a
  // notice -- a distinction that decides whether to retry narrower.
  resultSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      size: { type: "integer", description: "Real size on disk, not the size returned." },
      encoding: { type: "string" },
      content: { type: "string", description: "UTF-8 text, bounded, with a notice appended when truncated." },
      truncated: { type: "boolean" },
      originalSize: { type: "integer" },
      returnedSize: { type: "integer" },
      limit: { type: "integer" },
      redacted: { type: "boolean" },
    },
  },
  failureBehavior: {
    NOT_FOUND: "error (absent path)",
    OUTSIDE_WORKSPACE: "error (refused before touching the filesystem)",
    IS_DIRECTORY: "error (use filesystem.search)",
    BINARY_CONTENT: "error (never decoded)",
    OUTPUT_LIMIT: "error (over the 1MB hard cap; not truncated)",
    TIMEOUT: "error (elapsed cap; filesystem tools are synchronous so this is the caller's)",
  },
  limits: { hardCapBytes: MAX_READ_BYTES, defaultOutputBytes: DEFAULT_MAX_BYTES },
  redaction: "Every credential-shaped substring in the returned content is replaced, and `redacted: true` says so.",
  events: ["tool.call", "tool.denied", "tool.error"],

  async execute(args = {}, ctx = {}) {
    const root = requireWorkspaceRoot(ctx);
    const { resolved } = resolveInWorkspace(root, args.path, { label: "path" });

    const st = statOrFail(resolved, "path");
    if (st.isDirectory()) {
      throw new ToolInvocationError(TOOL_ERROR.IS_DIRECTORY, "path is a directory; use filesystem.search to list it", {
        path: resolved,
      });
    }

    let raw;
    try {
      raw = fs.readFileSync(resolved);
    } catch (err) {
      throw fromSystemError(err, "file");
    }

    if (looksBinary(raw)) {
      throw new ToolInvocationError(TOOL_ERROR.BINARY_CONTENT, "file appears to be binary and was not decoded", {
        path: resolved,
        size: st.size,
      });
    }

    const limit = clampInt(args.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_READ_BYTES);
    // The hard cap is the read ceiling, not the output bound: refusing a 2MB file
    // is honest, whereas returning its first 256KB is not.
    enforceByteLimit(st.size, MAX_READ_BYTES, { label: "file" });

    const text = raw.toString("utf8");
    const bounded = boundOutput(text, limit, { label: "file contents", redaction: redact });

    return {
      path: resolved,
      size: st.size,
      encoding: "utf8",
      content: bounded.text,
      truncated: bounded.truncated,
      originalSize: bounded.originalSize,
      returnedSize: bounded.returnedSize,
      limit: bounded.limit,
      redacted: bounded.text !== text,
    };
  },
};

// ---------------------------------------------------------------------------
// filesystem.write
// ---------------------------------------------------------------------------

export const writeTool = {
  name: "filesystem.write",
  scope: TOOL_SCOPE.WRITE,
  description:
    "Create or overwrite a UTF-8 text file inside the workspace, atomically. Existing content must be replaced deliberately via overwrite.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean", description: "Must be true to replace an existing file. Defaults to false." },
      mode: { type: "integer", description: "POSIX mode for a newly created file, e.g. 420 for 0644." },
    },
  },
  resultSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      bytes: { type: "integer", description: "Bytes written, after encoding." },
      created: { type: "boolean" },
      overwritten: { type: "boolean" },
      mode: { type: "integer" },
    },
  },
  failureBehavior: {
    OUTSIDE_WORKSPACE: "error (refused before any filesystem mutation)",
    ALREADY_EXISTS: "error unless overwrite: true",
    NO_SUCH_TARGET_FOR_OVERWRITE: "error (overwrite: true on a path that does not exist)",
    IS_DIRECTORY: "error",
    PERMISSION_DENIED: "error (OS-level, reported as an error rather than silently skipped)",
  },
  limits: { maxBytes: MAX_WRITE_BYTES },
  redaction: "None needed: the model supplied the content, and the waterfall's credential gate refuses a call whose arguments contain a key before this runs.",
  events: ["tool.call", "tool.denied", "tool.error"],

  async execute(args = {}, ctx = {}) {
    const root = requireWorkspaceRoot(ctx);
    if (typeof args.content !== "string") {
      throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "content must be a string");
    }
    enforceByteLimit(Buffer.byteLength(args.content, "utf8"), MAX_WRITE_BYTES, { label: "content" });

    const { resolved } = resolveInWorkspace(root, args.path, { label: "path" });

    // A write through a link is a write to the link's target. Containment already
    // proved the target is inside the workspace, so this is safe -- but a symlink
    // pointing at a file *outside* was already refused by resolveInWorkspace.
    const exists = fs.existsSync(resolved);
    if (exists && args.overwrite !== true) {
      const st = statOrFail(resolved, "path");
      throw new ToolInvocationError(
        TOOL_ERROR.INVALID_INPUT,
        st.isDirectory()
          ? "path is a directory"
          : "file already exists; pass overwrite: true to replace it",
        { path: resolved, exists: true },
      );
    }

    if (exists && statOrFail(resolved, "path").isDirectory()) {
      throw new ToolInvocationError(TOOL_ERROR.IS_DIRECTORY, "path is a directory", { path: resolved });
    }

    // Refuse rather than clobber: writing content into an existing file with no
    // acknowledgement is how an agent destroys work it did not know was there.
    if (args.overwrite === true && !exists) {
      throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "overwrite was requested but no file exists at path", {
        path: resolved,
      });
    }

    const mode = args.mode == null ? 0o600 : clampInt(args.mode, 0o600, 0, 0o777);

    try {
      if (!exists) fs.mkdirSync(path.dirname(resolved), { recursive: true });
    } catch (err) {
      throw fromSystemError(err, "parent directory");
    }

    // Atomic via a sibling temp file and rename. A reader must never observe a
    // half-written file, and a crash must not leave one.
    const tmp = `${resolved}.aflow-${process.pid}-${Date.now()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, "wx", mode);
      fs.writeFileSync(fd, args.content, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, resolved);
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* the original failure is the interesting one */
        }
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      throw fromSystemError(err, "file");
    }

    return {
      path: resolved,
      bytes: Buffer.byteLength(args.content, "utf8"),
      created: !exists,
      overwritten: exists,
      mode: mode & 0o777,
    };
  },
};

// ---------------------------------------------------------------------------
// filesystem.search
// ---------------------------------------------------------------------------

export const searchTool = {
  name: "filesystem.search",
  scope: TOOL_SCOPE.SEARCH,
  description:
    "Search workspace files for a pattern or filename substring. Bounded in matches, bytes and output; reports what it did not return.",
  inputSchema: {
    type: "object",
    required: ["pattern"],
    additionalProperties: false,
    properties: {
      pattern: { type: "string", description: "Substring to find. Treated as literal text, not a regex." },
      path: { type: "string", description: "Directory to search, workspace-relative. Defaults to the workspace root." },
      name: { type: "string", description: "Only consider files whose name contains this substring." },
      maxMatches: { type: "integer", minimum: 1, maximum: 5000, description: "Defaults to 200." },
      maxBytes: { type: "integer", minimum: 1, maximum: DEFAULT_MAX_BYTES, description: "Output bound. Defaults to 256KB." },
    },
  },
  resultSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      root: { type: "string", description: "Absolute directory searched." },
      matchCount: { type: "integer", description: "Matches returned, not matches found." },
      truncated: { type: "boolean" },
      truncationReason: { type: "string", enum: ["match-limit", "byte-budget", null] },
      returnedSize: { type: "integer" },
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string", description: "Workspace-relative, usable directly with filesystem.read." },
            line: { type: "integer" },
            text: { type: "string", description: "The matching line, capped at 400 characters." },
          },
        },
      },
      output: { type: "string", description: "The rendered result, including what was searched and what was withheld." },
      stats: { type: "object" },
    },
  },
  failureBehavior: {
    OUTSIDE_WORKSPACE: "error (refused before walking anything)",
    INVALID_INPUT: "error (empty or non-string pattern)",
    IS_DIRECTORY: "error (path is not a directory)",
    UNREADABLE_ENTRY: "skipped, counted in stats -- one unreadable file does not fail the search",
  },
  limits: {
    maxMatches: 5000,
    defaultMatches: 200,
    walkBudgetBytes: MAX_SEARCH_BYTES,
    defaultOutputBytes: DEFAULT_MAX_BYTES,
    skippedDirectories: [...SKIP_DIRS],
  },
  redaction: "Applied to each match line and to the rendered output.",
  events: ["tool.call", "tool.denied", "tool.error"],

  async execute(args = {}, ctx = {}) {
    const root = requireWorkspaceRoot(ctx);
    if (typeof args.pattern !== "string" || args.pattern === "") {
      throw new ToolInvocationError(TOOL_ERROR.INVALID_INPUT, "pattern must be a non-empty string");
    }

    const maxMatches = clampInt(args.maxMatches, 200, 1, 5000);
    const maxBytes = clampInt(args.maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);

    const { resolved: startDir } = resolveInWorkspace(root, args.path ?? ".", { label: "path" });
    const startStat = statOrFail(startDir, "path");
    if (!startStat.isDirectory()) {
      throw new ToolInvocationError(TOOL_ERROR.IS_DIRECTORY, "search path is not a directory", { path: startDir });
    }

    const needle = args.pattern;
    const nameFilter = typeof args.name === "string" ? args.name : null;

    const matches = [];
    const filesSearched = [];
    let bytesScanned = 0;
    let filesScanned = 0;
    let truncated = false;
    let stoppedBecause = null;
    // Real directories already walked, by their resolved identity. A link inside the
    // workspace pointing at one of its own ancestors would otherwise be followed
    // forever: each visit has a fresh path but the same inode, so nothing but an
    // identity set stops `a/b/link -> a`.
    const visitedDirs = new Set();

    const walk = (dir) => {
      if (stoppedBecause) return;
      // Checked here and again per file. Checking only on entry to a directory
      // meant a single 200MB file was read whole before the budget was consulted,
      // which is not a budget at all -- it is a check between large reads.
      if (bytesScanned >= MAX_SEARCH_BYTES) {
        truncated = true;
        stoppedBecause = "byte-budget";
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // an unreadable directory is not worth failing the whole search
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (stoppedBecause) return;
        if (bytesScanned >= MAX_SEARCH_BYTES) {
          truncated = true;
          stoppedBecause = "byte-budget";
          return;
        }
        const full = path.join(dir, entry.name);

        if (entry.isSymbolicLink()) {
          // Follow a link only if it stays inside. A link out of the workspace is
          // exactly what the containment rule forbids, and skipping it here is
          // what stops an unbounded walk through /proc or a home directory.
          let target;
          try {
            target = fs.realpathSync.native ? fs.realpathSync.native(full) : fs.realpathSync(full);
          } catch {
            continue; // broken link
          }
          if (!isWithin(startDir, target)) continue;
          if (visitedDirs.has(target)) continue;
          try {
            entry = fs.statSync(full);
          } catch {
            continue;
          }
        }

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          let key;
          try {
            key = fs.realpathSync.native ? fs.realpathSync.native(full) : fs.realpathSync(full);
          } catch {
            continue;
          }
          if (visitedDirs.has(key)) continue;
          visitedDirs.add(key);
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (nameFilter && !entry.name.includes(nameFilter)) continue;

        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        filesScanned += 1;

        // Refuse a file larger than the whole budget rather than reading it and
        // discovering afterwards that it was too big to have been worth reading.
        if (bytesScanned + st.size > MAX_SEARCH_BYTES) {
          truncated = true;
          stoppedBecause = "byte-budget";
          return;
        }

        let buf;
        try {
          buf = fs.readFileSync(full);
        } catch {
          continue; // unreadable, e.g. a lock held by another process
        }
        bytesScanned += buf.length;
        if (looksBinary(buf)) continue;

        // Relative to the workspace root, never to the search root. A model holding
        // a path relative to wherever it pointed the search has to re-derive the
        // base on every follow-up call, and the two bases disagree with each other
        // in the same result. One base, always the workspace, makes every match
        // usable as-is with filesystem.read.
        const rel = path.relative(root, full) || entry.name;
        filesSearched.push(rel);

        const text = buf.toString("utf8");
        let from = 0;
        for (;;) {
          const at = text.indexOf(needle, from);
          if (at === -1) break;
          const lineNo = text.slice(0, at).split("\n").length;
          const lineStart = text.lastIndexOf("\n", at - 1) + 1;
          const lineEnd = text.indexOf("\n", at);
          matches.push({
            file: rel,
            line: lineNo,
            text: (lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd)).slice(0, 400),
          });
          from = at + needle.length;
          if (matches.length >= maxMatches) {
            truncated = true;
            stoppedBecause = "match-limit";
            return;
          }
        }
      }
    };

    walk(startDir);

    const rendered = boundList(matches, {
      maxItems: maxMatches,
      maxBytes,
      label: "matches",
      render: (m) => `${m.file}:${m.line}: ${m.text}`,
    });

    const body =
      rendered.items.length === 0
        ? `no matches for ${JSON.stringify(needle)} under ${path.relative(root, startDir) || "."}`
        : rendered.items.map((m) => `${m.file}:${m.line}: ${redact(m.text)}`).join("\n");

    const parts = [body];
    // Gated on the walk's own flag, not just the renderer's. The walk stops at
    // maxMatches, so it can end holding *exactly* maxMatches entries -- at which
    // point the list bound is satisfied and reports no truncation, while matches
    // were very much withheld. Gating only on the renderer would drop the notice
    // in precisely the case where it matters most.
    if (rendered.truncated || truncated) {
      const withheld = Math.max(matches.length - rendered.returnedCount, stoppedBecause === "match-limit" ? 1 : 0);
      parts.push(
        `[truncated: showing ${rendered.returnedCount} of ${withheld > 0 ? `${matches.length}${stoppedBecause === "match-limit" ? "+" : ""}` : matches.length} matches` +
          `${stoppedBecause ? `; stopped at ${stoppedBecause}` : ""}. Narrow the pattern or path.]`,
      );
    }
    parts.push(
      `[searched ${filesScanned} files, ${bytesScanned} bytes, ${filesSearched.length} text files matched the filters;` +
        ` ${SKIP_DIRS.size} directory names skipped: ${[...SKIP_DIRS].join(", ")}]`,
    );

    return {
      pattern: needle,
      root: startDir,
      matchCount: rendered.returnedCount,
      truncated: rendered.truncated || truncated,
      truncationReason: stoppedBecause,
      returnedSize: rendered.returnedSize,
      matches: rendered.items,
      output: parts.join("\n"),
      stats: { filesScanned, bytesScanned, textFiles: filesSearched.length, totalFound: matches.length },
    };
  },
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export const filesystemTools = [readTool, writeTool, searchTool];

export default { readTool, writeTool, searchTool, filesystemTools, looksBinary, MAX_READ_BYTES, MAX_SEARCH_BYTES };