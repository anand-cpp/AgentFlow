// Diagnostics collector.
//
// The server pushes `textDocument/publishDiagnostics` notifications that are
// keyed by URI, may arrive more than once per file, and can be empty (the empty
// list is how a server says "this file is clean now"). This manager turns that
// firehose into a queryable view -- per file, or every error in the workspace --
// and gives callers a race-free way to wait for the result of a specific save.

import path from "node:path";
import { uriToPath, pathToUri } from "./client.js";

const SEVERITY = { 1: "Error", 2: "Warning", 3: "Information", 4: "Hint" };

/** Human label for an LSP numeric severity. */
export function severityLabel(severity) {
  return SEVERITY[severity] ?? "Error";
}

/**
 * @typedef {object} Diagnostic
 * @property {string} file absolute path
 * @property {{ start: { line: number, character: number }, end: { line: number, character: number } }} range
 * @property {"Error"|"Warning"|"Information"|"Hint"} severity
 * @property {number|string|null} code
 * @property {string|null} source
 * @property {string} message
 */

/**
 * @param {string} uri
 * @param {any} raw a raw LSP diagnostic
 * @returns {Diagnostic}
 */
function normalise(uri, raw) {
  return {
    file: uri.startsWith("file://") ? uriToPath(uri) : uri,
    range: {
      start: { line: raw?.range?.start?.line ?? 0, character: raw?.range?.start?.character ?? 0 },
      end: { line: raw?.range?.end?.line ?? 0, character: raw?.range?.end?.character ?? 0 },
    },
    severity: severityLabel(raw?.severity ?? 1),
    code: raw?.code ?? null,
    source: raw?.source ?? null,
    message: String(raw?.message ?? "").trim(),
  };
}

export class LspDiagnosticsManager {
  #client;
  #byUri = new Map();
  #revision = new Map();
  #off;

  /**
   * @param {{ on: (type: string, fn: (detail: any) => void) => (() => void) }} client
   */
  constructor(client) {
    this.#client = client;
    this.#off = client.on("diagnostics", ({ uri, diagnostics }) => this.record(uri, diagnostics));
  }

  /** Record a publishDiagnostics batch for a URI. */
  record(uri, diagnostics) {
    if (!uri) return;
    const revision = (this.#revision.get(uri) ?? 0) + 1;
    this.#revision.set(uri, revision);
    const list = Array.isArray(diagnostics) ? diagnostics.map((d) => normalise(uri, d)) : [];
    this.#byUri.set(uri, list);
    return list;
  }

  /** Current revision counter for a URI (0 if never seen). */
  revisionOf(uri) {
    return this.#revision.get(uri) ?? 0;
  }

  diagnosticsForUri(uri) {
    return this.#byUri.get(uri) ?? [];
  }

  diagnosticsForFile(filePath) {
    const uri = pathToUri(filePath);
    if (this.#byUri.has(uri)) return this.#byUri.get(uri);
    // Fall back to a filesystem comparison so a caller holding a path with a
    // different spelling (relative, alternate separators) still matches.
    const resolved = path.resolve(String(filePath));
    const found = [];
    for (const list of this.#byUri.values()) {
      for (const d of list) if (d.file === resolved) found.push(d);
    }
    return found;
  }

  /** Every diagnostic across every file the server has reported. */
  getAll() {
    const out = [];
    for (const list of this.#byUri.values()) out.push(...list);
    return out;
  }

  /** Every error (severity Error) currently known. */
  getErrors() {
    return this.getAll().filter((d) => d.severity === "Error");
  }

  /** Errors for one file. */
  errorsFor(filePath) {
    return this.diagnosticsForFile(filePath).filter((d) => d.severity === "Error");
  }

  hasErrors(filePath = null) {
    return (filePath ? this.errorsFor(filePath) : this.getErrors()).length > 0;
  }

  /**
   * Resolve once a publishDiagnostics for `uri` newer than `sinceRevision`
   * arrives, or after `timeoutMs`. Returns the current diagnostics either way,
   * so a server that stays silent is a timeout, not a hang.
   *
   * @param {string} uri
   * @param {{ sinceRevision?: number, timeoutMs?: number }} [opts]
   */
  waitFor(uri, { sinceRevision = 0, timeoutMs = 1000 } = {}) {
    if (this.revisionOf(uri) > sinceRevision) {
      return Promise.resolve(this.diagnosticsForUri(uri));
    }
    return new Promise((resolve) => {
      let off = () => {};
      let settled = false;
      const safeResolve = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        off();
        safeResolve(this.diagnosticsForUri(uri));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      off = this.#client.on("diagnostics", (detail) => {
        if (detail.uri !== uri) return;
        if (this.revisionOf(uri) <= sinceRevision) return;
        clearTimeout(timer);
        off();
        safeResolve(this.diagnosticsForUri(uri));
      });
    });
  }

  /** Drop everything the server has told us (used on server restart). */
  clear() {
    this.#byUri.clear();
    this.#revision.clear();
  }

  /** Detach from the client. */
  dispose() {
    this.#off?.();
  }
}

/**
 * Render diagnostics as plain text, one line per diagnostic.
 * @param {Diagnostic[]} diagnostics
 * @param {{ cwd?: string, max?: number }} [opts]
 */
export function formatDiagnosticsForConsole(diagnostics, { cwd = process.cwd(), max = 50 } = {}) {
  if (!diagnostics.length) return "no diagnostics";
  const shown = diagnostics.slice(0, max);
  const lines = shown.map((d) => {
    const rel = path.relative(cwd, d.file) || d.file;
    const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const code = d.code != null ? ` [${d.code}]` : "";
    return `${d.severity}: ${rel}:${pos}: ${d.message}${code}`;
  });
  if (diagnostics.length > shown.length) {
    lines.push(`… and ${diagnostics.length - shown.length} more`);
  }
  return lines.join("\n");
}

export default { LspDiagnosticsManager, severityLabel };
