// One error contract for every real tool.
//
// The tools in this directory fail in a small number of ways, and an agent that
// can read a file has to be able to tell "that path does not exist" from "that
// path is outside the workspace" from "the file is 400MB". A prose message is
// not enough: the model has to branch on it, and it has to branch the same way
// every time.
//
// So failures are a closed set of codes (TOOL_ERROR) carried on a typed error,
// and the message is for humans while the code is for the caller. Nothing here
// ever puts a filesystem path's *contents* or an environment value into a
// message -- see the note on `describe` below.

/**
 * The closed set of tool failure codes.
 *
 * Deliberately not an open string: `runTool` already collapses a thrown error
 * into `{ code, message }`, so this vocabulary is the whole contract between a
 * tool and whatever reads its result. Adding a code is a deliberate act.
 */
export const TOOL_ERROR = {
  /** Arguments failed validation before anything was touched. */
  INVALID_INPUT: "INVALID_INPUT",
  /** The permission model refused. Reported by the waterfall, not thrown here. */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** Resolved outside the workspace, lexically or through a link. */
  PATH_OUTSIDE_WORKSPACE: "PATH_OUTSIDE_WORKSPACE",
  NOT_FOUND: "NOT_FOUND",
  IS_DIRECTORY: "IS_DIRECTORY",
  /** Refused rather than returned as mojibake. */
  BINARY_CONTENT: "BINARY_CONTENT",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  /** Non-zero exit. Carries the code; see `ToolInvocationError.exitCode`. */
  PROCESS_FAILED: "PROCESS_FAILED",
  /** The work succeeded but the output exceeded its bound and was cut. */
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * A tool failure with a machine-readable code.
 *
 * `details` is bounded and caller-controlled. It is what lets a read report *why*
 * it refused -- which limit, which encoding -- without the message having to
 * carry it, and without any risk of a tool inventing prose that a caller might
 * parse.
 *
 * Details are kept in one object rather than spread onto the error, because
 * `runTool` rebuilds a failure as `{ code, message, step }` and only carries
 * across what a tool explicitly put in `details`. Opt-in, so widening what a
 * tool can leak into a result is a deliberate act rather than a side effect of
 * adding a property.
 */
export class ToolInvocationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToolInvocationError";
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

export function isToolInvocationError(err) {
  return err instanceof ToolInvocationError;
}

/**
 * The details a tool volunteered, if they are safe to carry into a result.
 *
 * Only own enumerable properties of a plain object, and only scalars. A tool that
 * put a path, a limit or a count in here gets those; one that put a stream or a
 * buffer in here does not, because a result is persisted into a session and
 * serialised into an event.
 */
export function safeErrorDetails(err) {
  const details = err?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Render an OS error as a tool failure.
 *
 * `ENOENT` and `EISDIR` and `EACCES` are the three an agent actually branches
 * on. Everything else is genuinely unexpected and becomes INTERNAL_ERROR rather
 * than inventing a code the contract does not have -- a wrong-but-specific code
 * is worse than an honest generic one, because the caller stops looking.
 */
export function fromSystemError(err, what = "path") {
  if (isToolInvocationError(err)) return err;
  const code = err?.code;
  if (code === "ENOENT") return new ToolInvocationError(TOOL_ERROR.NOT_FOUND, `${what} does not exist`, { path: err.path });
  if (code === "EISDIR") return new ToolInvocationError(TOOL_ERROR.IS_DIRECTORY, `${what} is a directory`, { path: err.path });
  if (code === "EACCES" || code === "EPERM") {
    return new ToolInvocationError(TOOL_ERROR.INTERNAL_ERROR, `${what} is not readable by this process`, { path: err.path });
  }
  return new ToolInvocationError(TOOL_ERROR.INTERNAL_ERROR, `${what} could not be accessed: ${code || "unknown"}`, { path: err?.path });
}