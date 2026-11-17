// Blackboard panel — displays AgentFlow's durable project memory.
//
// Shows: goal, objective, tasks, decisions, blockers, bugs, findings, timeline.
// Uses real Blackboard data (no mocks).

import { paintToken } from "./theme-engine.js";
import { bold, dim, width, truncate, pad } from "../cli/ui.js";

/** Task status color mapping. */
function statusColor(status) {
  switch (status) {
    case "done": return "success";
    case "in_progress": return "accent";
    case "blocked": return "error";
    case "pending": return "mutedText";
    case "cancelled": return "warning";
    default: return "mutedText";
  }
}

/** Severity color mapping. */
function severityColor(severity) {
  switch (severity) {
    case "critical": return "error";
    case "high": return "warning";
    case "medium": return "accentSecondary";
    case "low": return "mutedText";
    case "info": return "info";
    default: return "mutedText";
  }
}

/** Render the blackboard panel. */
export function renderBlackboard(blackboard, opts = {}) {
  const { w = 40 } = opts;
  const lines = [];

  lines.push(paintToken("Blackboard — Project Memory", "accent", "bold"));
  lines.push("");

  if (!blackboard) {
    lines.push(dim("No blackboard for this project."));
    return lines.join("\n");
  }

  // Goal
  if (blackboard.goal) {
    lines.push(paintToken("Goal", "accent", "bold"));
    lines.push(`  ${truncate(blackboard.goal, w - 4)}`);
    lines.push("");
  }

  // Objective
  if (blackboard.objective) {
    lines.push(paintToken("Objective", "accent", "bold"));
    lines.push(`  ${truncate(blackboard.objective, w - 4)}`);
    lines.push("");
  }

  // Tasks
  const tasks = blackboard.tasks || [];
  if (tasks.length > 0) {
    lines.push(paintToken("Tasks", "accent", "bold"));
    for (const task of tasks.slice(0, 6)) {
      const status = paintToken(task.status, statusColor(task.status));
      const title = truncate(task.title, w - 10);
      lines.push(`  [${status}] ${title}`);
    }
    if (tasks.length > 6) {
      lines.push(`  … and ${tasks.length - 6} more`);
    }
    lines.push("");
  }

  // Decisions
  const decisions = blackboard.decisions || [];
  if (decisions.length > 0) {
    lines.push(paintToken("Decisions", "accent", "bold"));
    for (const decision of decisions.slice(0, 4)) {
      lines.push(`  • ${truncate(decision.title, w - 6)}`);
    }
    lines.push("");
  }

  // Blockers
  const blockers = blackboard.blockers || [];
  if (blockers.length > 0) {
    lines.push(paintToken("Blockers", "error", "bold"));
    for (const blocker of blockers.slice(0, 4)) {
      const sev = paintToken(blocker.severity || "medium", severityColor(blocker.severity));
      lines.push(`  [!] ${truncate(blocker.title, w - 6)} ${dim(sev)}`);
    }
    lines.push("");
  }

  // Bugs
  const bugs = blackboard.bugs || [];
  if (bugs.length > 0) {
    lines.push(paintToken("Bugs", "error", "bold"));
    for (const bug of bugs.slice(0, 4)) {
      lines.push(`  🐛 ${truncate(bug.title, w - 6)}`);
    }
    lines.push("");
  }

  // Findings
  const findings = blackboard.findings || [];
  if (findings.length > 0) {
    lines.push(paintToken("Findings", "info", "bold"));
    for (const finding of findings.slice(0, 4)) {
      lines.push(`  • ${truncate(finding.title, w - 6)}`);
    }
    lines.push("");
  }

  // Timeline
  const checkpoints = blackboard.recentCheckpoints || [];
  if (checkpoints.length > 0) {
    lines.push(paintToken("Timeline", "mutedText", "bold"));
    for (const cp of checkpoints.slice(0, 5)) {
      const time = dim(cp.ts ? cp.ts.slice(11, 16) : "--:--");
      lines.push(`  ${time} ${truncate(cp.summary, w - 12)}`);
    }
    lines.push("");
  }

  if (lines.length <= 2) {
    lines.push(dim("Empty blackboard. Start a session to begin."));
  }

  return lines.join("\n");
}
