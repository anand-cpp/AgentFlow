// Inline tool-approval UI.
//
// When the permission waterfall answers `ask`, the interactive CLI has to put a
// question to the human: this module renders that question and collects the
// answer. It is deliberately fail-closed everywhere it possibly can be —
// non-interactive streams, a timeout, EOF, a crash, or an unrecognised key all
// resolve to "no". Only an explicit `y`/`a` approves.
//
// Answers:
//   y  allow once
//   a  allow always (the caller remembers the scope/tool for the session)
//   n  deny
//   d  toggle the diff preview (for file writes) or the raw command (for shell)
//
// The rendering and the decision interpretation are pure and separately
// testable; the interactive driver is a thin wrapper that races a keypress (or a
// caller-supplied line reader, for the chat loop) against a 60-second deadline.
//
// Zero runtime dependencies.

import readline from "node:readline";

import { drawBox } from "./components.js";
import { bold, dim, green, red, yellow } from "../cli/ui.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DIFF_LINES = 120;

/**
 * Classify a call so the prompt can lead with the fact that matters.
 * @param {{tool?:string, scope?:string, args?:object}} request
 * @returns {"shell"|"write"|"other"}
 */
export function classifyApproval(request = {}) {
  if (request.scope === "shell") return "shell";
  if (request.scope === "write") return "write";
  return "other";
}

/** The exact shell command a call would run, if any. */
export function commandOf(request = {}) {
  const args = request.args || {};
  return args.command || args.cmd || args.script || "";
}

/** The target path of a write call, if any. */
export function pathOf(request = {}) {
  const args = request.args || {};
  return args.path || args.file || args.filename || "";
}

/**
 * A compact LCS-based line diff between two strings.
 *
 * Bounded to MAX_DIFF_LINES on each side: a diff is a decision aid, not a
 * full-file renderer, and an unbounded LCS on a huge file would be both slow and
 * unreadable.
 *
 * @returns {Array<{type:"add"|"del"|"ctx", text:string}>}
 */
export function computeDiff(oldText, newText) {
  const a = String(oldText ?? "").split(/\r?\n/);
  const b = String(newText ?? "").split(/\r?\n/);
  // Bounded to MAX_DIFF_LINES on each side: a diff is a decision aid.
  const aBound = a.slice(0, MAX_DIFF_LINES);
  const bBound = b.slice(0, MAX_DIFF_LINES);
  const bn = aBound.length;
  const bm = bBound.length;
  const dp = Array.from({ length: bn + 1 }, () => new Array(bm + 1).fill(0));
  for (let i = bn - 1; i >= 0; i -= 1) {
    for (let j = bm - 1; j >= 0; j -= 1) {
      dp[i][j] = aBound[i] === bBound[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = /** @type {Array<{type:"add"|"del"|"ctx", text:string}>} */ ([]);
  let i = 0;
  let j = 0;
  while (i < bn && j < bm) {
    if (aBound[i] === bBound[j]) {
      out.push({ type: "ctx", text: aBound[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: aBound[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: bBound[j] });
      j += 1;
    }
  }
  while (i < bn) out.push({ type: "del", text: aBound[i++] });
  while (j < bm) out.push({ type: "add", text: bBound[j++] });
  return out;
}

/** Render a diff as coloured +/- lines, capped for the screen. */
export function renderDiff(diff, { max = 40 } = {}) {
  const linesOut = [];
  let shown = 0;
  for (let i = 0; i < diff.length; i += 1) {
    if (shown >= max) break;
    const d = diff[i];
    const parts = String(d.text ?? "").split(/\r?\n/);
    for (let p = 0; p < parts.length; p += 1) {
      if (shown >= max) break;
      const t = parts[p];
      if (d.type === "add") linesOut.push(green(`+ ${t}`));
      else if (d.type === "del") linesOut.push(red(`- ${t}`));
      else linesOut.push(dim(`  ${t}`));
      shown += 1;
    }
  }
  if (diff.reduce((acc, d) => acc + String(d.text ?? "").split(/\r?\n/).length, 0) > max) {
    linesOut.push(dim(`  … more line(s)`));
  }
  return linesOut.join("\n");
}

/**
 * Render the approval prompt box.
 *
 * @param {{tool?:string, scope?:string, args?:object}} request
 * @param {{width?:number, diff?:Array<object>|null, continuation?:boolean}} [options]
 * @returns {string}
 */
export function renderApproval(request, options = {}) {
  const width = options.width || 72;
  const kind = classifyApproval(request);
  const body = [];

  if (options.continuation) {
    body.push(yellow("A tool call may not have completed before the provider failed."));
    body.push(`The tool was: ${bold(request.tool || "a tool")}`);
  } else {
    body.push(`${dim("scope")} ${bold(request.scope || "unknown")}`);
  }

  if (kind === "shell") {
    const cmd = commandOf(request);
    body.push("");
    body.push(bold("$ ") + (cmd || dim("(no command given)")));
  } else if (options.diff) {
    body.push("");
    body.push(renderDiff(options.diff));
  } else if (kind === "write") {
    body.push("");
    body.push(`${bold("write")} ${pathOf(request) || dim("(no path given)")}`);
  } else {
    body.push("");
    const args = request.args && Object.keys(request.args).length ? JSON.stringify(request.args) : "{}";
    body.push(dim(args.length > 200 ? `${args.slice(0, 200)}…` : args));
  }

  body.push("");
  body.push(dim("[y] allow once   [a] allow always   [n] deny   [d] diff"));

  return drawBox(`Approve ${request.tool || "tool"}`, body.join("\n"), {
    width,
    borderColor: kind === "shell" ? "red" : "yellow",
  });
}

/**
 * Interpret a single answer key.
 * @returns {"allow-once"|"allow-always"|"deny"|"diff"|"ignore"}
 */
export function interpretChoice(input) {
  const ch = String(input ?? "").trim().toLowerCase();
  if (ch === "y" || ch === "yes") return "allow-once";
  if (ch === "a" || ch === "always") return "allow-always";
  if (ch === "n" || ch === "no") return "deny";
  if (ch === "d" || ch === "diff") return "diff";
  return "ignore";
}

/** Whether a request carries a diffable file write. */
function diffable(request) {
  const args = request.args || {};
  return classifyApproval(request) === "write" && (typeof args.oldText === "string" || typeof args.newText === "string");
}

/**
 * @param {object} [options]
 * @param {import("node:stream").Readable} [options.input]
 * @param {import("node:stream").Writable} [options.output]
 * @param {boolean} [options.interactive]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.width]
 * @param {Function} [options.readLine]
 * @param {Set<string>} [options.always]
 * @param {(request:object)=>string} [options.keyOf]
 */
export function decideApproval(request, options = {}) {
  const input = options.input || process.stdin;
  // Default output is a sink unless a real TTY is present: writing the prompt to
  // a pipe (or a test harness) would corrupt the consumer's stream. A caller
  // that wants the box printed passes `output` explicitly.
  const isTTY = Boolean((/** @type {any} */ (process.stdout)).isTTY);
  const output = options.output || (isTTY ? process.stdout : { write: () => {} });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const interactive = options.interactive ?? Boolean((/** @type {any} */ (input)).isTTY);

  if (!interactive) {
    return Promise.resolve({ approved: false, remember: false, reason: "non-interactive" });
  }

  let showDiff = false;
  const draw = () => {
    const diff = showDiff && diffable(request) ? computeDiff(request.args?.oldText, request.args?.newText) : null;
    output.write(`\n${renderApproval(request, { width: options.width, diff, continuation: request.continuation })}\n`);
  };

  const deadline = Date.now() + timeoutMs;

  // Line-reader path: used by the chat loop, whose readline owns the input
  // already. Raw mode there would fight the reader.
  if (typeof options.readLine === "function") {
    return (async () => {
      draw();
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { approved: false, remember: false, reason: "timeout" };
        const line = await Promise.race([
          options.readLine(),
          new Promise((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (line === null || line === undefined) return { approved: false, remember: false, reason: "timeout-or-eof" };
        const choice = interpretChoice(line);
        if (choice === "diff") {
          showDiff = !showDiff;
          draw();
          continue;
        }
        if (choice === "allow-once") return { approved: true, remember: false, reason: "allow-once" };
        if (choice === "allow-always") return { approved: true, remember: true, reason: "allow-always" };
        if (choice === "deny") return { approved: false, remember: false, reason: "denied" };
        // ignore: ask again
        draw();
      }
    })();
  }

  // Keypress path: standalone use and tests.
  return new Promise((resolve) => {
    const canRaw = Boolean((/** @type {any} */ (input)).isTTY && typeof (/** @type {any} */ (input)).setRawMode === "function");
    readline.emitKeypressEvents(input);
    if (canRaw) (/** @type {any} */ (input)).setRawMode(true);

    let settled = false;
    const timer = setTimeout(() => finish({ approved: false, remember: false, reason: "timeout" }), timeoutMs);
    if (timer.unref) timer.unref();

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("keypress", onKey);
      if (canRaw && typeof (/** @type {any} */ (input)).setRawMode === "function") {
        try { (/** @type {any} */ (input)).setRawMode(false); } catch (err) { void err; }
      }
      resolve(result);
    }

    function onKey(str, key) {
      if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        return finish({ approved: false, remember: false, reason: "cancelled" });
      }
      const choice = interpretChoice(str);
      if (choice === "diff") {
        showDiff = !showDiff;
        draw();
        return undefined;
      }
      if (choice === "allow-once") return finish({ approved: true, remember: false, reason: "allow-once" });
      if (choice === "allow-always") return finish({ approved: true, remember: true, reason: "allow-always" });
      if (choice === "deny") return finish({ approved: false, remember: false, reason: "denied" });
      return undefined;
    }

    input.on("keypress", onKey);
    if (typeof input.resume === "function") input.resume();
    return draw();
  });
}

/**
 * Build an approver function for the permission waterfall.
 *
 * The engine calls `approver(state.call, tool)` and expects a boolean. This
 * adapter adds two behaviours on top of `decideApproval`: a per-session set of
 * "always" keys so an `a` answer is honoured on later calls, and the
 * fail-closed `=== true` mapping the engine relies on.
 *
 * @param {object} [options]  Passed through to decideApproval; plus:
 * @param {Set<string>} [options.always]  Pre-seeded always-allow keys.
 * @param {(request:object)=>string} [options.keyOf]  Identity for remember.
 * @param {import("node:stream").Readable} [options.input]
 * @param {import("node:stream").Writable} [options.output]
 * @param {boolean} [options.interactive]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.width]
 * @param {Function} [options.readLine]
 * @returns {(call:object, tool?:object)=>Promise<boolean>}
 */
export function createApprover(options = {}) {
  const always = options.always || new Set();
  const keyOf = options.keyOf || ((request) => request.scope || request.tool || "?");
  return async (call) => {
    if (!call) return false;
    if (always.has(keyOf(call))) return true;
    const result = await decideApproval(call, options);
    if (result.approved && result.remember) always.add(keyOf(call));
    return result.approved === true;
  };
}

export default {
  classifyApproval,
  commandOf,
  pathOf,
  computeDiff,
  renderDiff,
  renderApproval,
  interpretChoice,
  decideApproval,
  createApprover,
};
