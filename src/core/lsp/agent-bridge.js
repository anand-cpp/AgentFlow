// Agent bridge: feed language-server diagnostics back into a run.
//
// The point of LSP inside an agent run is the feedback loop. When the agent
// writes a file, the server re-analyses it and reports errors; this bridge turns
// that notification into text the next prompt carries, so the model sees the
// consequences of its own edit and can correct them in the same task. Everything
// here is advisory and defensive -- a language server that is slow, absent, or
// broken must never fail or stall the run.

import fs from "node:fs";
import path from "node:path";
import { pathToUri } from "./client.js";

export class LspAgentBridge {
  #client;
  #diagnostics;
  #root;
  #waitMs;
  #maxErrors;
  #log;

  /**
   * @param {{
   *   client: import("./client.js").LspClient,
   *   diagnostics: import("./diagnostics.js").LspDiagnosticsManager,
   *   workspaceRoot?: string|null,
   *   waitMs?: number,
   *   maxErrors?: number,
   *   log?: object,
   * }} options
   */
  constructor({ client, diagnostics, workspaceRoot = null, waitMs = 1000, maxErrors = 10, log = null }) {
    if (!client || !diagnostics) {
      throw new Error("LspAgentBridge requires a client and a diagnostics manager");
    }
    this.#client = client;
    this.#diagnostics = diagnostics;
    this.#root = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
    this.#waitMs = waitMs;
    this.#maxErrors = maxErrors;
    this.#log = log;
  }

  /** True when the underlying server is alive and can be queried. */
  get active() {
    return this.#client?.process?.running === true;
  }

  /**
   * Open or refresh a document from disk and wait briefly for diagnostics.
   * Returns the diagnostics for the file (possibly the previous batch on timeout).
   *
   * @param {string} filePath
   * @param {{ waitMs?: number }} [opts]
   */
  async refresh(filePath, { waitMs = this.#waitMs } = {}) {
    if (!this.active) return [];
    const abs = path.resolve(String(filePath));
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return []; // deleted or binary; nothing to analyse
    }
    const uri = pathToUri(abs);
    const before = this.#diagnostics.revisionOf(uri);
    try {
      if (this.#client.isOpen(abs)) this.#client.didChange(abs, text);
      else this.#client.didOpen(abs, text);
    } catch (err) {
      this.#log?.warn?.(`lsp: could not open ${abs}: ${err?.message ?? err}`);
      return [];
    }
    return this.#diagnostics.waitFor(uri, { sinceRevision: before, timeoutMs: waitMs });
  }

  /** Called after a write tool succeeds; refreshes diagnostics for the file. */
  async afterWrite(filePath) {
    return this.refresh(filePath);
  }

  /** All current error-severity diagnostics. */
  getErrors() {
    return this.#diagnostics.getErrors();
  }

  /**
   * A compact block for the agent prompt. Empty string when there is nothing to
   * report, so the caller can append unconditionally.
   */
  renderPromptBlock() {
    const errors = this.#diagnostics.getErrors();
    if (errors.length === 0) return "";
    const shown = errors.slice(0, this.#maxErrors);
    const lines = ["[lsp] recent language-server errors:"];
    for (const e of shown) {
      const rel = path.relative(this.#root, e.file) || e.file;
      lines.push(`- ${rel}:${e.range.start.line + 1}:${e.range.start.character + 1} ${e.message}`);
    }
    if (errors.length > shown.length) lines.push(`- …and ${errors.length - shown.length} more`);
    lines.push("Address these errors before continuing.");
    return lines.join("\n");
  }

  /** Stop the server and detach. Safe to call more than once. */
  async stop() {
    this.#diagnostics?.dispose?.();
    await this.#client?.stop?.();
  }
}

export default { LspAgentBridge };
