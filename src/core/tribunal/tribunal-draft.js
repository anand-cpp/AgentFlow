// Tribunal draft artifacts.
//
// When the Oracle returns INSUFFICIENT_CONFIDENCE, the run is not a verdict --
// it is an incomplete investigation. This module writes the partial result to a
// draft artifact under .agentflow/tribunal/draft.<tribunal_id>.json so the
// user can review, fix, and re-run without losing what the tribunal already
// established.
//
// Drafts are fail-safe: a failure to write one never prevents a run from
// completing, and an existing draft is never silently overwritten by a new run
// with a different id.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** The tribunal draft directory, under the platform state directory. */
export function tribunalDraftDir(stateDir = null) {
  const base = stateDir
    ? String(stateDir)
    : process.env.AGENTFLOW_STATE_DIR ||
      (process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local", "agentflow")
        : path.join(os.homedir(), ".local", "state", "agentflow"));
  return path.join(base, "tribunal");
}

/** Build the draft file path for a run. */
export function draftFilePath(tribunalId, stateDir = null) {
  const dir = tribunalDraftDir(stateDir);
  return path.join(dir, `draft.${String(tribunalId ?? "run")}.json`);
}

/**
 * Write a draft artifact for an INSUFFICIENT_CONFIDENCE tribunal result.
 * Never throws; returns { ok, path, error }.
 *
 * @param {object} draftInput  { tribunalId, verdict, confidence, caveats, findings, ... }
 * @param {string} [stateDir]
 * @returns {{ ok: boolean, path: string|null, error: string|null }}
 */
export function writeDraft(draftInput, stateDir = null) {
  const draft = draftInput ?? {};
  const tribunalId = draft.tribunalId ?? "run";
  const file = draftFilePath(tribunalId, stateDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      tribunal_id: tribunalId,
      verdict: draft.verdict ?? null,
      confidence: typeof draft.confidence === "number" ? draft.confidence : null,
      caveats: Array.isArray(draft.caveats) ? draft.caveats : [],
      findings: Array.isArray(draft.findings) ? draft.findings : [],
      written_at: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    return { ok: true, path: file, error: null };
  } catch (err) {
    return { ok: false, path: null, error: err?.message ?? String(err) };
  }
}

/**
 * Read a draft artifact, if one exists. Returns null when there is no draft.
 *
 * @param {string} tribunalId
 * @param {string} [stateDir]
 * @returns {{ ok: boolean, draft: object|null, path: string|null, error: string|null }}
 */
export function readDraft(tribunalId, stateDir = null) {
  const file = draftFilePath(tribunalId, stateDir);
  try {
    if (!fs.existsSync(file)) return { ok: true, draft: null, path: file, error: null };
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: true, draft: payload, path: file, error: null };
  } catch (err) {
    return { ok: false, draft: null, path: null, error: err?.message ?? String(err) };
  }
}

/** List all draft artifacts in the tribunal directory. */
export function listDrafts(stateDir = null) {
  const dir = tribunalDraftDir(stateDir);
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => f.startsWith("draft.") && f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

export default {
  tribunalDraftDir,
  draftFilePath,
  writeDraft,
  readDraft,
  listDrafts,
};
