// The real tool set, and how it reaches the runtime.
//
// Until now the runtime had no tools at all: `aflow agent run` constructed a map
// of none, so a model that asked to read a file was told there was no such tool.
// This module is the other half -- the implementations, assembled into the shape
// `AgentRuntime` already expects (`Map<name, tool>`) with nothing about the
// permission model reimplemented.
//
// The wiring is deliberately thin. `runTool` already does permission, approval,
// guards, the credential gate, scrubbing and the log; these tools only own the
// filesystem and process facts it cannot know. If a tool ever needs to decide
// whether a call is allowed, that is a bug -- the answer belongs to tools.js.

import { filesystemTools } from "./tool-filesystem.js";
import { shellTools } from "./tool-shell.js";

/** Every real tool, in the order they should be offered to a model. */
export const REAL_TOOLS = [...filesystemTools, ...shellTools];

export const REAL_TOOL_NAMES = REAL_TOOLS.map((t) => t.name);

/**
 * Build the tool map for a runtime.
 *
 * `overrides` lets a caller replace or extend the set, which is how a test
 * substitutes an instrumented tool without a second registration path in
 * production code.
 */
export function createRealTools(overrides = {}) {
  const map = new Map();
  for (const tool of REAL_TOOLS) map.set(tool.name, tool);
  for (const [name, tool] of Object.entries(overrides)) {
    if (tool == null) map.delete(name);
    else map.set(name, tool);
  }
  return map;
}

/**
 * The default tool scopes an agent needs for the real tools to be reachable.
 *
 * Not a grant -- `evaluatePermission` still requires an allow entry for each
 * call. This only answers "which scopes must exist before any of this can
 * possibly be allowed", which keeps an agent from being handed a read tool whose
 * scope it was never given and watching every call fail with a confusing reason.
 */
export const REAL_TOOL_SCOPES = ["read", "search", "write", "shell"];

export default { REAL_TOOLS, REAL_TOOL_NAMES, REAL_TOOL_SCOPES, createRealTools };