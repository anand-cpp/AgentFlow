// Tribunal fight-card renderer.
//
// Stage 5 hands back a single record: five stage results, an Oracle report, and
// a battle report. That record is complete but dense -- a wall of nested objects
// that says everything and shows nothing. This module turns it into the one
// thing a person actually reads after a run: a fight card.
//
// The card is deliberately one box with one section per round, in the order the
// tribunal ran them. Everything it prints is read defensively -- a run that
// terminated early (a skipped merge, an aborted oracle) still renders, with the
// missing rounds saying why rather than rendering "undefined". A renderer that
// crashes on the unhappy path is worse than no renderer, because the unhappy
// path is the one a person most needs to read.
//
// Colour comes from cli/ui.js, so NO_COLOR, TERM=dumb, and non-TTY output all
// degrade to plain text without this file making a single TTY decision itself.

import { CRUCIBLE_SEVERITY } from "./crucible-schema.js";
import { ORACLE_VERDICT } from "./oracle-schema.js";
import { TRIAL_VERDICT } from "./trial-schema.js";
import {
  bold,
  dim,
  red,
  green,
  yellow,
  cyan,
  gray,
  bgRed,
  bgGreen,
  bgYellow,
  pad,
  truncate,
} from "../../cli/ui.js";

const DEFAULT_WIDTH = 68;

// Severity is the tribunal's one damage scale, shared by the Crucible and the
// Trial. Mapping it to colour here means every finding reads the same wherever
// it appears on the card.
const SEVERITY_PAINT = {
  [CRUCIBLE_SEVERITY.P0_CRITICAL]: (t) => red(bold(t)),
  [CRUCIBLE_SEVERITY.P1_MAJOR]: (t) => yellow(t),
  [CRUCIBLE_SEVERITY.P2_MINOR]: (t) => dim(t),
  [CRUCIBLE_SEVERITY.P3_INFORMATIONAL]: (t) => gray(t),
};

function paintSeverity(severity) {
  const paint = SEVERITY_PAINT[severity] ?? ((t) => dim(t));
  return paint(String(severity ?? "?"));
}

// The verdict is the headline of the whole card: bold text on a solid field so
// it reads at a glance, colour-coded by how good the news is.
const VERDICT_PAINT = {
  [ORACLE_VERDICT.VERIFIED]: (t) => bold(bgGreen(t)),
  [ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE]: (t) => bold(bgYellow(t)),
  [ORACLE_VERDICT.REJECTED]: (t) => bold(bgRed(t)),
  [ORACLE_VERDICT.ABORTED]: (t) => bold(gray(t)),
};

function paintVerdict(verdict) {
  const paint = VERDICT_PAINT[verdict] ?? ((t) => bold(t));
  return paint(` ${verdict ?? "UNKNOWN"} `);
}

function pct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function num(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** `2026-10-04T07:15:30.000Z` -> `2026-10-04 07:15`; short and unambiguous. */
function stamp(iso) {
  if (typeof iso !== "string" || iso.length < 16) return "-";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Draw one heavy-bordered box, one inner section per round.
 *
 * @param {Array<Array<string>>} sections  each section is a list of lines
 * @param {number} [width]
 * @returns {string}
 */
export function renderBox(sections, width = DEFAULT_WIDTH) {
  const inner = Math.max(8, width - 2);
  const rule = (left, mid, right) => `${left}${mid.repeat(inner)}${right}`;
  const lines = [];
  lines.push(rule("\u2554", "\u2550", "\u2557")); // ╔ ═ ╗
  sections.forEach((section, index) => {
    if (index > 0) lines.push(rule("\u2560", "\u2550", "\u2563")); // ╠ ═ ╣
    for (const line of section) {
      lines.push(`\u2551${pad(truncate(line, inner), inner)}\u2551`); // ║ … ║
    }
  });
  lines.push(rule("\u255a", "\u2550", "\u255d")); // ╚ ═ ╝
  return lines.join("\n");
}

function stageOf(result, key) {
  return isObject(result?.stages) ? result.stages[key] ?? null : null;
}

// ---------------------------------------------------------------------------
// rounds
// ---------------------------------------------------------------------------

function headerSection(result) {
  return [
    `  ${bold("TRIBUNAL FIGHT CARD")}`,
    "",
    `  ${dim("id      ")} ${result?.tribunal_id ?? "-"}`,
    `  ${dim("domain  ")} ${result?.domain ?? "general"}`,
    `  ${dim("started ")} ${stamp(result?.startedAt)}`,
    `  ${dim("finished")} ${stamp(result?.completedAt)}`,
  ];
}

function roundTitle(label, blurb) {
  return `  ${bold(label)}  ${dim(blurb)}`;
}

function forgeSection(stage1) {
  const lines = [roundTitle("ROUND 1 \u00b7 FORGE", "self-adversarial review")];
  const candidates = asArray(stage1?.candidates);
  if (!stage1) {
    lines.push(`  ${dim("stage did not run")}`);
    return lines;
  }
  if (candidates.length === 0) {
    lines.push(`  ${dim("no candidates were submitted")}`);
    return lines;
  }
  for (const candidate of candidates) {
    const review = candidate?.review ?? null;
    const outcome = candidate?.outcome ?? (candidate?.ok === false ? "invalid_review" : "reviewed");
    const conf = review
      ? `conf ${num(review.confidenceBefore)} \u2192 ${num(review.confidenceAfter)}`
      : dim("conf -");
    const decision = review?.decision ?? candidate?.decision ?? "-";
    lines.push(
      `  ${pad(String(candidate?.id ?? "?"), 20)} ${pad(String(candidate?.model ?? "-"), 16)} ${outcome}  ${conf}  ${decision}`,
    );
  }
  const summary = stage1?.summary;
  if (isObject(summary)) {
    lines.push("", `  ${dim(`${summary.total ?? candidates.length} candidate(s) \u00b7 ${summary.reviewed ?? 0} reviewed \u00b7 ${summary.invalid ?? 0} unreadable \u00b7 ${summary.revised ?? 0} revised`)}`);
  }
  return lines;
}

function crucibleSection(stage2) {
  const lines = [roundTitle("ROUND 2 \u00b7 CRUCIBLE", "cross-examination")];
  if (!stage2) {
    lines.push(`  ${dim("stage did not run")}`);
    return lines;
  }
  const results = asArray(stage2?.results);
  if (results.length === 0) {
    lines.push(`  ${dim("no proposals were cross-examined")}`);
    return lines;
  }
  for (const result of results) {
    const findings = asArray(result?.aggregatedFindings);
    lines.push(
      `  ${bold(String(result?.proposalId ?? "?"))}  survival ${num(result?.survivalScore)}  ${dim(`${findings.length} finding(s)`)}`,
    );
    for (const finding of findings) {
      lines.push(
        `    ${paintSeverity(finding?.severity)} ${dim(String(finding?.vector ?? "?"))} ${truncate(String(finding?.title ?? "(untitled)"), 36)}`,
      );
    }
  }
  const summary = stage2?.summary;
  if (isObject(summary)) {
    lines.push("", `  ${dim(`${summary.findings ?? 0} finding(s) across ${summary.reports ?? 0} report(s) \u00b7 avg survival ${num(summary.averageSurvival)}`)}`);
  }
  return lines;
}

function mergeSection(stage3) {
  const lines = [roundTitle("ROUND 3 \u00b7 MERGE", "hybrid synthesis")];
  if (!stage3) {
    lines.push(`  ${dim("stage did not run")}`);
    return lines;
  }
  const status = stage3?.status ?? "-";
  const report = stage3?.result?.report ?? null;
  lines.push(`  ${dim("status  ")} ${status}`);
  if (isObject(stage3?.gate)) lines.push(`  ${dim("gate    ")} ${truncate(String(stage3.gate.reason ?? "-"), 50)}`);

  if (status !== "COMPLETED" || !report) {
    if (stage3?.reason) lines.push(`  ${dim("reason  ")} ${truncate(String(stage3.reason), 50)}`);
    if (asArray(stage3?.errors).length) {
      for (const error of stage3.errors) lines.push(`  ${red("x")} ${truncate(String(error), 52)}`);
    }
    return lines;
  }

  lines.push(`  ${dim("decision")} ${bold(String(report.decision ?? "-"))}`);
  const elements = asArray(report?.hybrid_solution?.elements);
  if (elements.length) {
    lines.push(`  ${dim("elements")} ${elements.length}`);
    for (const element of elements.slice(0, 5)) {
      const sources = asArray(element?.source_proposal_ids).join(", ") || "-";
      lines.push(`    ${cyan(String(element?.element_id ?? "?"))} ${dim(`from ${sources}`)}`);
    }
  }
  const resolutions = asArray(report?.findings_resolution);
  if (resolutions.length) {
    lines.push(`  ${dim("findings")}`);
    for (const entry of resolutions.slice(0, 8)) {
      const colour =
        entry?.status === "ADDRESSED" ? green : entry?.status === "DISPUTED" ? yellow : gray;
      lines.push(`    ${String(entry?.finding_id ?? "?")} ${colour(String(entry?.status ?? "?"))}`);
    }
  }
  if (report?.insufficiency_reason) {
    lines.push(`  ${yellow("insufficient")} ${truncate(String(report.insufficiency_reason), 44)}`);
  }
  return lines;
}

function trialSection(stage4) {
  const lines = [roundTitle("ROUND 4 \u00b7 TRIAL", "prosecution")];
  if (!stage4) {
    lines.push(`  ${dim("stage did not run")}`);
    return lines;
  }
  const status = stage4?.status ?? "-";
  const verdict = stage4?.outcome?.verdict ?? stage4?.finalVerdict ?? stage4?.trialResult?.report?.verdict ?? status;
  lines.push(`  ${dim("status  ")} ${status}`);
  lines.push(`  ${dim("verdict ")} ${verdict === TRIAL_VERDICT.ACQUITTED ? green(bold(String(verdict))) : verdict === TRIAL_VERDICT.MISTRIAL ? gray(String(verdict)) : red(bold(String(verdict)))}`);
  const report = stage4?.trialResult?.report ?? stage4?.finalTrial?.report ?? null;
  const findings = asArray(report?.findings);
  if (findings.length) {
    lines.push(`  ${dim("findings")}`);
    for (const finding of findings.slice(0, 8)) {
      lines.push(
        `    ${paintSeverity(finding?.severity)} ${dim(String(finding?.vector ?? "?"))} ${truncate(String(finding?.title ?? "(untitled)"), 34)}`,
      );
    }
  } else if (report) {
    lines.push(`  ${dim("no findings raised by the prosecutor")}`);
  }
  if (stage4?.reason) lines.push(`  ${dim("reason  ")} ${truncate(String(stage4.reason), 50)}`);
  const history = asArray(stage4?.history);
  if (history.length > 1) {
    const chain = history.map((h) => h?.verdict ?? "?").join(" \u2192 ");
    lines.push(`  ${dim("retries ")} ${truncate(chain, 50)}`);
  }
  return lines;
}

function oracleSection(oracle, battleReport) {
  const lines = [roundTitle("ROUND 5 \u00b7 ORACLE", "the gate")];
  if (!oracle) {
    lines.push(`  ${dim("no oracle report")}`);
    return lines;
  }
  lines.push(`  ${paintVerdict(oracle.verdict)}  ${dim("confidence")} ${bold(pct(oracle.confidence))}`);
  if (isObject(battleReport)) {
    lines.push(`  ${dim(truncate(String(battleReport.summary ?? ""), 60))}`);
    const totals = battleReport.total_findings;
    if (isObject(totals)) {
      lines.push(
        `  ${dim(`findings P0 ${totals.p0 ?? 0} \u00b7 P1 ${totals.p1 ?? 0} \u00b7 P2 ${totals.p2 ?? 0} \u00b7 P3 ${totals.p3 ?? 0} \u00b7 unresolved critical ${battleReport.unresolved_critical ?? 0}`)}`,
      );
    }
    if (battleReport.winner) lines.push(`  ${green("winner")} ${truncate(String(battleReport.winner), 48)}`);
  }

  const breakdown = oracle.confidence_breakdown;
  if (isObject(breakdown)) {
    lines.push("", `  ${dim("weights")} ${dim("self " + num(breakdown.weights?.self_review) + " \u00b7 survival " + num(breakdown.weights?.survival) + " \u00b7 merge " + num(breakdown.weights?.merge) + " \u00b7 trial " + num(breakdown.weights?.trial) + " \u00b7 validation " + num(breakdown.weights?.validation))}`);
    lines.push(
      `  ${dim("scores ")} ${dim(`self ${num(breakdown.self_review_score)} \u00b7 survival ${num(breakdown.survival_score)} \u00b7 merge ${num(breakdown.merge_quality_score)} \u00b7 trial ${num(breakdown.trial_score)} \u00b7 validation ${num(breakdown.validation_score)}`)}`,
    );
  }

  const checks = asArray(oracle.validation_checks);
  if (checks.length) {
    lines.push("", `  ${bold("validation checks")}`);
    for (const check of checks) {
      const mark = check?.passed === true ? green("\u2713") : red("\u2717");
      lines.push(`    ${mark} ${truncate(String(check?.name ?? check?.check_id ?? "?"), 24)} ${dim(truncate(String(check?.details ?? ""), 30))}`);
    }
  }

  const caveats = asArray(oracle.caveats);
  if (caveats.length && caveats[0] !== "No caveats recorded.") {
    lines.push("", `  ${bold("caveats")}`);
    for (const caveat of caveats.slice(0, 5)) lines.push(`    ${yellow("!")} ${truncate(String(caveat), 52)}`);
  }
  return lines;
}

/**
 * Render the whole fight card. Accepts a runFullTribunal() result and never
 * throws: a partial or empty record renders with the gaps named.
 *
 * @param {object} tribunalResult
 * @param {object} [options]
 * @param {number} [options.width]
 * @returns {string}
 */
export function renderFightCard(tribunalResult, options = {}) {
  const result = isObject(tribunalResult) ? tribunalResult : {};
  const width = Number.isInteger(options.width) && options.width > 20 ? options.width : DEFAULT_WIDTH;

  const sections = [
    headerSection(result),
    forgeSection(stageOf(result, "stage1")),
    crucibleSection(stageOf(result, "stage2")),
    mergeSection(stageOf(result, "stage3")),
    trialSection(stageOf(result, "stage4")),
    oracleSection(result.oracle, result.battle_report),
  ];

  return renderBox(sections, width);
}

/**
 * A one-line summary of a stored TRIBUNAL_RUN entry, for `tribunal history`.
 * @param {object} entry
 * @returns {string}
 */
export function renderHistoryRow(entry) {
  const verdict = entry?.verdict ?? "UNKNOWN";
  const colour =
    verdict === ORACLE_VERDICT.VERIFIED
      ? green
      : verdict === ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE
        ? yellow
        : verdict === ORACLE_VERDICT.ABORTED
          ? gray
          : red;
  const conf = typeof entry?.confidence === "number" ? pct(entry.confidence) : "-";
  return `  ${dim(stamp(entry?.ts))}  ${pad(String(entry?.tribunal_id ?? "?"), 36)}  ${pad(colour(String(verdict)), 24)}  ${dim(conf)}  ${dim(truncate(String(entry?.domain ?? "general"), 12))}`;
}

export default { renderFightCard, renderBox, renderHistoryRow };
