// Tribunal visualization — renders AgentFlow's five-stage adversarial pipeline
// as a visual fight card inside the TUI.
//
// Stages: Forge → Crucible → Merge → Trial → Oracle
// Uses real tribunal data (no mocks, no simulated status).

import { paintToken } from "./theme-engine.js";
import { dim, truncate } from "../cli/ui.js";

/** Stage order and their semantic color tokens. */
export const TRIBUNAL_STAGES = [
  { key: "forge", name: "FORGE", token: "tribunalForge" },
  { key: "crucible", name: "CRUCIBLE", token: "tribunalCrucible" },
  { key: "merge", name: "MERGE", token: "tribunalMerge" },
  { key: "trial", name: "TRIAL", token: "tribunalTrial" },
  { key: "oracle", name: "ORACLE", token: "tribunalOracle" },
];

/** Status color mapping. */
function statusColor(status) {
  switch (status) {
    case "COMPLETED": return "success";
    case "RUNNING": return "accent";
    case "PENDING": return "mutedText";
    case "SKIPPED": return "warning";
    case "INVALID_RESULT": return "error";
    case "MISTRIAL": return "error";
    default: return "mutedText";
  }
}

/** Verdict color mapping. */
function verdictColor(verdict) {
  switch (verdict) {
    case "VERIFIED": return "success";
    case "INSUFFICIENT_CONFIDENCE": return "warning";
    case "REJECTED": return "error";
    case "ABORTED": return "error";
    default: return "mutedText";
  }
}

/** Render a single stage row. */
function renderStageRow(stage, result, isCurrent) {
  const lines = [];
  const namePaint = paintToken(stage.name, stage.token, "bold");
  const status = result ? (result.status || "PENDING") : "PENDING";
  const statusPaint = paintToken(status, statusColor(status));

  let detail = "";
  if (result) {
    if (stage.key === "forge" && result.summary) {
      detail = `reviewed ${result.summary.reviewed ?? 0}/${result.summary.total ?? 0}`;
    } else if (stage.key === "crucible" && result.summary) {
      detail = `findings ${result.summary.findings ?? 0}`;
    } else if (stage.key === "merge" && result.result) {
      detail = `decision ${result.result.decision ?? "—"}`;
    } else if (stage.key === "trial" && result.outcome) {
      detail = `verdict ${result.outcome.verdict ?? "—"}`;
    } else if (stage.key === "oracle" && result.oracleResult) {
      detail = `confidence ${(result.oracleResult.confidence ?? 0).toFixed(0)}%`;
    }
  }

  const marker = isCurrent ? "▶ " : "  ";
  lines.push(`${marker}${namePaint} ${statusPaint} ${dim(detail)}`);
  return lines;
}

/** Render the full tribunal visualization. */
export function renderTribunal(tribunalResult, opts = {}) {
  const { w = 60 } = opts;
  const lines = [];

  lines.push(paintToken("Tribunal — Five-Stage Adversarial Review", "accent", "bold"));
  lines.push("");

  if (!tribunalResult) {
    lines.push(dim("No tribunal run yet. Use /tribunal to start one."));
    return lines.join("\n");
  }

  const stages = tribunalResult.stages || {};

  // Render each stage in order
  TRIBUNAL_STAGES.forEach((stage, i) => {
    const stageKey = `stage${i + 1}`;
    const result = stages[stageKey];
    const isCurrent = i === 0; // Simplified: mark first incomplete as current

    // Find the first incomplete stage to mark as current
    let currentFound = false;
    for (let j = 0; j <= i; j += 1) {
      const prevKey = `stage${j + 1}`;
      const prevResult = stages[prevKey];
      if (prevResult && (prevResult.status === "COMPLETED" || prevResult.status === "SKIPPED" || prevResult.status === "INVALID_RESULT" || prevResult.status === "MISTRIAL")) {
        // Already done, not current
      } else if (!currentFound) {
        currentFound = true;
      }
    }

    const stageLines = renderStageRow(stage, result, isCurrent && result);
    lines.push(...stageLines);
    lines.push("");
  });

  // Oracle verdict banner
  const oracle = stages.stage5?.oracleResult;
  if (oracle) {
    const verdict = paintToken(oracle.verdict, verdictColor(oracle.verdict), "bold");
    const confidence = paintToken(`${(oracle.confidence ?? 0).toFixed(0)}%`, "mutedText");
    const finalOutput = oracle.final_output ? `output: ${truncate(oracle.final_output, w - 10)}` : "no output";

    lines.push("");
    lines.push(paintToken("Oracle Verdict", "accent", "bold"));
    lines.push(`  ${verdict}  confidence: ${confidence}`);
    if (finalOutput !== "output: ") lines.push(`  ${finalOutput}`);
    if (oracle.caveats && oracle.caveats.length > 0) {
      lines.push(`  caveats: ${oracle.caveats.length}`);
    }
  }

  // Battle report rounds
  const battle = tribunalResult.battle_report;
  if (battle && battle.rounds) {
    lines.push("");
    lines.push(paintToken("Battle Report", "accent", "bold"));
    for (const round of battle.rounds) {
      const roundLabel = paintToken(`round ${round.round_number}`, "mutedText");
      const events = round.events ? round.events.join(" · ") : "";
      lines.push(`  ${roundLabel} ${dim(round.stage)}: ${events}`);
    }
    if (battle.winner) {
      lines.push(`  winner: ${paintToken(battle.winner, "success", "bold")}`);
    }
  }

  return lines.join("\n");
}