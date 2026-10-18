// Tribunal JSONL audit stream.
//
// Every significant tribunal event is appended as one JSON line to
// `.agentflow/tribunal/<task>_<timestamp>.jsonl`. The stream is append-only:
// once written, an event is never rewritten or deleted. This gives a durable,
// machine-readable record of what the tribunal decided and why, independent of
// the session store or blackboard.
//
// Events are fail-safe: a failure to write an audit line never prevents a
// tribunal run from completing. The audit is a record, not a gate.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** The tribunal audit directory, under the platform state directory. */
export function tribunalAuditDir(stateDir = null) {
  const base = stateDir
    ? String(stateDir)
    : process.env.AGENTFLOW_STATE_DIR ||
      (process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local", "agentflow")
        : path.join(os.homedir(), ".local", "state", "agentflow"));
  return path.join(base, "tribunal");
}

/** Build the audit file path for a run. */
export function auditFilePath(taskId, stateDir = null) {
  const dir = tribunalAuditDir(stateDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTask = String(taskId ?? "run").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(dir, `${safeTask}_${ts}.jsonl`);
}

/** Open an audit file for appending. Creates the directory if needed.
 *  Returns a handle object with `append`, `close`, and `path`. Never throws;
  * on any failure the handle is a no-op so the tribunal run is never blocked.
 *
 * @param {string} taskId
 * @param {string} [stateDir]
 * @returns {{ append: (event: object) => void, close: () => void, path: string, enabled: boolean }}
 */
export function openAudit(taskId, stateDir = null) {
  const file = auditFilePath(taskId, stateDir);
  let fd = null;
  let enabled = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, "a");
    enabled = true;
  } catch {
    // If we cannot open the audit file, the handle is a silent no-op.
    fd = null;
    enabled = false;
  }

  const append = (event) => {
    if (!enabled || fd === null) return;
    try {
      const { event: eventName, stage: eventStage, ts: eventTs, ...rest } = event ?? {};
      const line = JSON.stringify({
        event: eventName ?? "event",
        stage: eventStage ?? null,
        ts: eventTs ?? new Date().toISOString(),
        ...rest,
      });
      fs.appendFileSync(file, line + "\n");
    } catch {
      // A single failed append must not break the run; stop trying.
      enabled = false;
    }
  };

  const close = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
  };

  return { append, close, path: file, enabled };
}

/** Convenience: run a callback with an open audit handle, closing it
 *  afterwards even if the callback throws.
 *
 * @param {string} taskId
 * @param {Function} withAudit  callback receiving { append, close, path, enabled }
 * @param {string} [stateDir]
 * @returns {any} the callback's return value
 */
export function withAudit(taskId, withAudit, stateDir = null) {
  const handle = openAudit(taskId, stateDir);
  try {
    return withAudit(handle);
  } finally {
    handle.close();
  }
}

export default {
  tribunalAuditDir,
  auditFilePath,
  openAudit,
  withAudit,
};
