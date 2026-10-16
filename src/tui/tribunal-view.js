// Live tribunal battle view.
//
// The fight card (src/core/tribunal/formatter.js) is the record of a tribunal
// that has already finished: one box, printed once, to stdout. This module is
// the view of one that is *running* -- a board of the five rounds with their
// live status, redrawn on stderr as the pipeline progresses, so a run that takes
// a minute does not look like a hang.
//
// The split matters. The command layer keeps printing its final artifact to
// stdout exactly as before (so `aflow tribunal run --json` and a piped fight
// card are untouched); progress is a separate, discardable stream. Every board
// here is a pure function of a plain state object: no timers, no terminal
// probes, no TTY decisions. Colour comes from cli/ui.js, so NO_COLOR and
// non-TTY output degrade to plain text without this file knowing.
//
// Read defensively throughout. A tribunal that aborts mid-stage still has a
// board to draw, and the unhappy path is exactly when a person is staring at
// this screen.

import {
  bold,
  dim,
  red,
  green,
  cyan,
  pad,
  truncate,
  width as uiWidth,
} from "../cli/ui.js";

/** The five rounds, in pipeline order. Shared by the board and the header. */
export const TRIBUNAL_ROUNDS = Object.freeze([
  { round: 1, stage: "FORGE", blurb: "self-adversarial review" },
  { round: 2, stage: "CRUCIBLE", blurb: "cross-examination" },
  { round: 3, stage: "MERGE", blurb: "hybrid synthesis" },
  { round: 4, stage: "TRIAL", blurb: "prosecution" },
  { round: 5, stage: "ORACLE", blurb: "the gate" },
]);

export const TOTAL_ROUNDS = TRIBUNAL_ROUNDS.length;

/**
 * @typedef {"pending"|"running"|"done"|"error"} LiveStatus
 *
 * @typedef {object} RoundState
 * @property {number} round
 * @property {string} stage
 * @property {string} blurb
 * @property {LiveStatus} status
 * @property {string|null} modelId
 * @property {number|null} percent
 * @property {Array<object>} findings
 * @property {object|null} result
 * @property {string|null} error
 *
 * @typedef {object} TribunalState
 * @property {string|null} tribunalId
 * @property {string} domain
 * @property {string|null} startedAt
 * @property {boolean} complete
 * @property {RoundState[]} rounds
 * @property {object|null} oracle
 * @property {object|null} battleReport
 */

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalise any status spelling the pipeline may hand us onto the four states. */
export function statusWord(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "running" || s === "active") return "running";
  if (s === "done" || s === "completed" || s === "ok") return "done";
  if (s === "error" || s === "aborted" || s === "failed") return "error";
  return "pending";
}

function statusMark(status) {
  switch (status) {
    case "running":
      return cyan("\u25cf"); // ●
    case "done":
      return green("\u2713"); // ✓
    case "error":
      return red("\u2717"); // ✗
    default:
      return dim("\u00b7"); // ·
  }
}

/**
 * A blank five-round board for one run.
 *
 * @param {object} [input]
 * @param {string|null} [input.tribunalId]
 * @param {string} [input.domain]
 * @param {string|null} [input.modelId]  stamped on every round until one reports
 * @param {string|null} [input.startedAt]
 * @returns {TribunalState}
 */
export function createTribunalState({ tribunalId = null, domain = "code", modelId = null, startedAt = null } = {}) {
  return {
    tribunalId,
    domain: String(domain ?? "code"),
    startedAt,
    complete: false,
    oracle: null,
    battleReport: null,
    rounds: TRIBUNAL_ROUNDS.map((entry) => ({
      round: entry.round,
      stage: entry.stage,
      blurb: entry.blurb,
      status: "pending",
      modelId: modelId ?? null,
      percent: null,
      findings: [],
      result: null,
      error: null,
    })),
  };
}

/**
 * Fold one progress event into the board. The command emits these from the
 * pipeline's onStage hook; a missing or malformed event leaves the board alone.
 *
 * @param {TribunalState} state
 * @param {object} [event]
 * @param {string} [event.stage]       FORGE | CRUCIBLE | MERGE | TRIAL | ORACLE
 * @param {string} [event.status]      running | done | error
 * @param {object} [event.result]      the stage result, once it lands
 * @param {string} [event.modelId]
 * @param {number} [event.percent]
 * @param {string} [event.error]
 * @returns {TribunalState} the same object, updated
 */
export function applyStageEvent(state, event = {}) {
  const board = isObject(state) ? state : createTribunalState();
  const rounds = Array.isArray(board.rounds) ? board.rounds : [];
  const wanted = String(event.stage ?? "").toUpperCase();
  const round = rounds.find((r) => r.stage === wanted);
  if (!round) return board;

  const status = statusWord(event.status);
  round.status = status;
  if (event.modelId) round.modelId = String(event.modelId);
  if (event.result !== undefined) round.result = event.result ?? null;
  if (event.error !== undefined && event.error !== null) round.error = String(event.error);
  round.percent =
    typeof event.percent === "number" && Number.isFinite(event.percent)
      ? Math.max(0, Math.min(100, Math.round(event.percent)))
      : status === "done"
        ? 100
        : status === "error"
          ? null
          : round.percent;

  if (status === "done" && event.result) {
    const oracle = event.stage === "ORACLE" ? (event.result.oracleResult ?? null) : null;
    if (isObject(oracle)) {
      board.oracle = oracle;
      board.battleReport = isObject(oracle.battle_report) ? oracle.battle_report : board.battleReport;
    }
  }

  board.complete = rounds.every((r) => r.status === "done" || r.status === "error");
  return board;
}

/**
 * The live board: a title line, one row per round, and -- once the Oracle has
 * reported -- the verdict. Never throws.
 *
 * @param {TribunalState|object} [tribunalState]
 * @param {object} [options]
 * @param {number} [options.width]
 * @returns {string}
 */
export function renderTribunalProgress(tribunalState = {}, options = {}) {
  const state = isObject(tribunalState) ? tribunalState : {};
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  const width = Number.isInteger(options.width) && options.width > 20 ? options.width : 0;

  const full = `${bold("TRIBUNAL")}  ${dim(String(state.tribunalId ?? "-"))}  ${dim("\u00b7")}  ${dim("domain")} ${String(state.domain ?? "code")}`;
  const compact = `${bold("TRIBUNAL")}  ${dim(String(state.tribunalId ?? "-"))}`;
  const title = width > 0 && width < uiWidth(full) ? compact : full;
  if (rounds.length === 0) return [title, dim("  no rounds recorded")].join("\n");

  const lines = [title, ""];
  for (const round of rounds) {
    const status = statusWord(round.status);
    lines.push(
      `  ${statusMark(status)} ${pad(String(round.round ?? "?"), 2)} ${pad(truncate(String(round.stage ?? "?"), 9), 9)} ${dim(status)}`,
    );
  }

  if (state.complete && state.oracle) {
    lines.push("", `  ${bold(String(state.oracle.verdict ?? "UNKNOWN"))}`);
  }

  return lines.join("\n");
}

export default {
  TRIBUNAL_ROUNDS,
  TOTAL_ROUNDS,
  createTribunalState,
  applyStageEvent,
  renderTribunalProgress,
};
