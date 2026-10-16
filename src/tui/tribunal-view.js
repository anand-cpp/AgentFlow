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
  yellow,
  gray,
  cyan,
  bgRed,
  bgGreen,
  bgYellow,
  pad,
  truncate,
  width as uiWidth,
} from "../cli/ui.js";
import { CRUCIBLE_SEVERITY } from "../core/tribunal/crucible-schema.js";
import { ORACLE_VERDICT, CONFIDENCE_THRESHOLD } from "../core/tribunal/oracle-schema.js";

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
    round.findings = findingsOf(round.stage, round.result);
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
 * The banner for whichever round is currently under the microscope. The blurb
 * is looked up from the round table rather than passed in, so the header can
 * never disagree with the pipeline's own stage list.
 *
 * @param {string} stage
 * @param {number} roundNumber
 * @param {number} [totalRounds]
 * @returns {string}
 */
export function renderRoundHeader(stage, roundNumber, totalRounds) {
  const name = String(stage ?? "?").toUpperCase();
  const entry = TRIBUNAL_ROUNDS.find((r) => r.stage === name) ?? { blurb: "" };
  const total = Number.isFinite(totalRounds) && totalRounds > 0 ? totalRounds : TOTAL_ROUNDS;
  const number = Number.isFinite(roundNumber) ? roundNumber : "?";
  const head = `${bold(`ROUND ${number}`)} ${dim("\u00b7")} ${bold(name)} ${dim(`(${number}/${total})`)}`;
  return entry.blurb ? `  ${head}  ${dim(entry.blurb)}` : `  ${head}`;
}

const BAR_CELLS = 10;

/**
 * The bar: how far along the run thinks the stage is. A stage the pipeline has
 * not reported a number for is drawn as "unknown" rather than as zero -- a
 * running round is not a stalled round, and the two must not look alike.
 *
 * @param {LiveStatus} status
 * @param {number|null} percent
 */
function progressBar(status, percent) {
  const known = typeof percent === "number" && Number.isFinite(percent);
  let body;
  if (status === "pending") {
    body = " ".repeat(BAR_CELLS);
  } else if (status === "error") {
    body = "\u2591".repeat(BAR_CELLS); // ░
  } else if (status === "done") {
    body = "\u2588".repeat(BAR_CELLS); // █
  } else {
    const filled = known ? Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS))) : 0;
    body = "\u25c6".repeat(filled) + "\u00b7".repeat(BAR_CELLS - filled); // ◆ … ·
  }
  const paint = status === "done" ? green : status === "error" ? red : status === "running" ? cyan : dim;
  return paint(`[${body}]`);
}

function percentText(status, percent) {
  if (status === "pending" || status === "error") return "  -";
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "  \u2026"; // …
  return `${pad(String(Math.round(percent)), 3, "right")}%`;
}

/**
 * One model's line: who is fighting, how they are doing, and how far along.
 *
 * @param {string|null} modelId
 * @param {string} status
 * @param {number|null} percent
 * @param {object} [options]
 * @param {number} [options.labelWidth]
 * @returns {string}
 */
export function renderModelProgress(modelId, status, percent, options = {}) {
  const word = statusWord(status);
  const known = typeof percent === "number" && Number.isFinite(percent);
  // A finished round is finished whatever the caller managed to record.
  const shown = word === "done" && !known ? 100 : percent;
  const labelWidth = Number.isInteger(options.labelWidth) && options.labelWidth > 4 ? options.labelWidth : 20;
  const label = pad(truncate(modelId ? String(modelId) : "(default)", labelWidth), labelWidth);
  return `${label}  ${pad(word, 8)}  ${progressBar(word, shown)}  ${percentText(word, shown)}`;
}

/** The round that deserves the banner: the running one, else the last started. */
function activeRound(rounds) {
  const running = rounds.find((r) => statusWord(r.status) === "running");
  if (running) return running;
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    if (statusWord(rounds[i].status) !== "pending") return rounds[i];
  }
  return rounds[0] ?? null;
}

// Severity and verdict share one palette with the fight card, so a finding reads
// the same colour wherever it appears.
const SEVERITY_PAINT = {
  [CRUCIBLE_SEVERITY.P0_CRITICAL]: (t) => red(bold(t)),
  [CRUCIBLE_SEVERITY.P1_MAJOR]: (t) => yellow(t),
  [CRUCIBLE_SEVERITY.P2_MINOR]: (t) => dim(t),
  [CRUCIBLE_SEVERITY.P3_INFORMATIONAL]: (t) => gray(t),
};

const VERDICT_PAINT = {
  [ORACLE_VERDICT.VERIFIED]: (t) => bold(bgGreen(t)),
  [ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE]: (t) => bold(bgYellow(t)),
  [ORACLE_VERDICT.REJECTED]: (t) => bold(bgRed(t)),
  [ORACLE_VERDICT.ABORTED]: (t) => bold(gray(t)),
};

/**
 * Pull the findings a stage produced, in the shape each stage stores them. The
 * Crucible scatters them per proposal; the Trial files them under its report.
 * Anything else has none -- this is a view, not a re-derivation.
 *
 * @param {string} stage
 * @param {object|null} result
 * @returns {Array<object>}
 */
function findingsOf(stage, result) {
  if (!isObject(result)) return [];
  if (stage === "CRUCIBLE") {
    const out = [];
    for (const report of Array.isArray(result.results) ? result.results : []) {
      for (const finding of Array.isArray(report?.aggregatedFindings) ? report.aggregatedFindings : []) {
        if (isObject(finding)) out.push(finding);
      }
    }
    return out;
  }
  if (stage === "TRIAL") {
    const report = result?.trialResult?.report ?? result?.finalTrial?.report ?? null;
    return Array.isArray(report?.findings) ? report.findings.filter(isObject) : [];
  }
  return [];
}

/**
 * Findings, one line each: severity, vector, title. Empty is a real answer.
 *
 * @param {Array<object>} findings
 * @returns {string}
 */
export function renderFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return `  ${dim("no findings")}`;
  return list
    .map((finding) => {
      const severity = String(finding?.severity ?? "?");
      const paint = SEVERITY_PAINT[severity] ?? ((t) => dim(t));
      const vector = dim(pad(truncate(String(finding?.vector ?? "-"), 10), 10));
      const title = truncate(String(finding?.title ?? "(untitled)"), 36);
      return `    ${paint(pad(severity, 18))} ${vector} ${title}`;
    })
    .join("\n");
}

/**
 * The Oracle's verdict and confidence, with the gate made explicit: the number
 * alone does not say whether it cleared, and that is the one thing a reader
 * wants to know.
 *
 * @param {object|null} oracleResult
 * @returns {string}
 */
export function renderOracleVerdict(oracleResult) {
  const oracle = isObject(oracleResult) ? oracleResult : null;
  if (!oracle) return `  ${dim("no oracle report")}`;
  const verdict = String(oracle.verdict ?? "UNKNOWN");
  const paint = VERDICT_PAINT[verdict] ?? ((t) => bold(t));
  const confidence = typeof oracle.confidence === "number" && Number.isFinite(oracle.confidence) ? oracle.confidence : null;
  const number = confidence === null ? "-" : confidence.toFixed(2);
  let gate = "";
  if (confidence !== null) {
    const clears = confidence >= CONFIDENCE_THRESHOLD;
    const mark = clears ? green("\u2713") : red("\u2717");
    gate = `  ${mark} ${dim(clears ? "clears" : "below")} ${dim(CONFIDENCE_THRESHOLD.toFixed(2))}`;
  }
  return `  ${paint(` ${verdict} `)}  ${dim("confidence")} ${bold(number)}${gate}`;
}

/**
 * The battle report as a short narration: the title, one line per round, the
 * finding tallies, and the winner. Never throws on a partial report.
 *
 * @param {object|null} battleReport
 * @returns {string}
 */
export function renderBattleReport(battleReport) {
  const report = isObject(battleReport) ? battleReport : null;
  if (!report) return `  ${dim("no battle report")}`;
  const lines = [];
  if (report.title) lines.push(`  ${bold(String(report.title))}`);
  if (report.summary) lines.push(`  ${dim(truncate(String(report.summary), 60))}`);

  const rounds = Array.isArray(report.rounds) ? report.rounds : [];
  for (const round of rounds.slice(0, TOTAL_ROUNDS)) {
    const events = Array.isArray(round?.events) ? round.events : [];
    lines.push(`    ${dim(`round ${round?.round_number ?? "?"}`)} ${bold(String(round?.stage ?? "?"))} ${dim(`\u00b7 ${events.length} event(s)`)}`);
    for (const event of events.slice(0, 3)) lines.push(`      ${dim(truncate(String(event), 54))}`);
  }

  const totals = report.total_findings;
  if (isObject(totals)) {
    lines.push(
      `    ${dim(`P0 ${totals.p0 ?? 0} \u00b7 P1 ${totals.p1 ?? 0} \u00b7 P2 ${totals.p2 ?? 0} \u00b7 P3 ${totals.p3 ?? 0} \u00b7 unresolved critical ${report.unresolved_critical ?? 0}`)}`,
    );
  }
  if (report.winner) lines.push(`    ${green("winner")} ${truncate(String(report.winner), 40)}`);

  return lines.length ? lines.join("\n") : `  ${dim("no battle report")}`;
}

/**
 * The live board: a title line, the banner for the round in flight, one row per
 * round, and -- once the Oracle has reported -- the verdict. Never throws.
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
  const active = activeRound(rounds);
  if (active) lines.push(renderRoundHeader(active.stage, active.round, rounds.length || TOTAL_ROUNDS), "");

  const labelWidth = width > 0 ? Math.max(6, Math.min(20, width - 47)) : 20;
  for (const round of rounds) {
    const status = statusWord(round.status);
    lines.push(
      `  ${statusMark(status)} ${pad(String(round.round ?? "?"), 2)} ${pad(truncate(String(round.stage ?? "?"), 9), 9)} ${renderModelProgress(round.modelId, status, round.percent, { labelWidth })}`,
    );
  }

  const findings = rounds.flatMap((round) => (statusWord(round.status) === "done" ? round.findings : []));
  if (findings.length) {
    lines.push("", `  ${bold(`findings (${findings.length})`)}`, renderFindings(findings.slice(0, 8)));
  }

  if (state.complete) {
    if (state.oracle) lines.push("", renderOracleVerdict(state.oracle));
    if (state.battleReport) lines.push("", renderBattleReport(state.battleReport));
  }

  return lines.join("\n");
}

export default {
  TRIBUNAL_ROUNDS,
  TOTAL_ROUNDS,
  createTribunalState,
  applyStageEvent,
  renderRoundHeader,
  renderModelProgress,
  renderFindings,
  renderOracleVerdict,
  renderBattleReport,
  renderTribunalProgress,
};
