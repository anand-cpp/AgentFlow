// Shared session input collection for Hackathon Mode.
//
// Both the CLI (`aflow hackathon start`) and the TUI (Ctrl+P command palette)
// must use this same validated service to collect the three required session
// inputs: total duration, elapsed time, and teammate count.
//
// No values are hardcoded. No previous session values are reused. The user
// is prompted interactively when flags are not provided.

import { bold, dim, yellow } from "../../cli/ui.js";

/** Whether the current environment supports interactive prompts. */
export const isInteractive = Boolean(
  process.stdin.isTTY && process.stdout.isTTY,
);

/** Read a line from stdin (interactive prompt). */
export async function prompt(question) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl.question(question).then((answer) => {
    rl.close();
    return answer.trim();
  });
}

/** Parse a non-negative integer, throwing on invalid input. */
export function parseNonNegativeInt(value, label) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer, got: ${value}`);
  }
  return n;
}

/** Parse a positive integer (>= 1), throwing on invalid input. */
export function parsePositiveInt(value, label) {
  const n = parseNonNegativeInt(value, label);
  if (n < 1) {
    throw new Error(`${label} must be at least 1, got: ${value}`);
  }
  return n;
}

/** The three required session inputs. */
export class SessionInputs {
  constructor({ totalDurationHours, elapsedHours, teammateCount, remainingHours }) {
    this.totalDurationHours = totalDurationHours;
    this.elapsedHours = elapsedHours;
    this.teammateCount = teammateCount;
    this.remainingHours = remainingHours;
  }

  toJSON() {
    return {
      totalDurationHours: this.totalDurationHours,
      elapsedHours: this.elapsedHours,
      remainingHours: this.remainingHours,
      teammateCount: this.teammateCount,
      totalMachines: this.teammateCount + 1,
    };
  }
}

/**
 * Collect the three required session inputs interactively.
 *
 * Flags are honored when provided (for scripting/automation); otherwise the
 * user is prompted. Validates: elapsed <= total, remaining > 0, teammates >= 1.
 *
 * Returns a SessionInputs instance.
 */
export async function collectSessionInputs(flags = {}) {
  // In non-interactive environments (no TTY), all three inputs must be
  // provided via flags. Hanging on prompt() would block CI forever.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    const missing = [];
    if (flags["duration-hours"] === undefined) missing.push("--duration-hours");
    if (flags["elapsed-hours"] === undefined) missing.push("--elapsed-hours");
    if (flags.teammates === undefined) missing.push("--teammates");
    if (missing.length > 0) {
      throw new Error(
        `Non-interactive environment requires ${missing.join(
          ", ",
        )} flags for session creation. Run: aflow hackathon start "<idea>" ${missing.join(
          " <value> ",
        )} <value>`,
      );
    }
  }

  let totalDurationHours;
  let elapsedHours;
  let teammateCount;

  // --- Question 1: Total duration ---
  if (flags["duration-hours"] !== undefined) {
    totalDurationHours = parsePositiveInt(
      flags["duration-hours"],
      "--duration-hours",
    );
  } else {
    process.stdout.write(bold("How many total hours does your hackathon have? "));
    const answer = await prompt("");
    totalDurationHours = parsePositiveInt(answer, "total duration");
  }

  // --- Question 2: Elapsed time ---
  if (flags["elapsed-hours"] !== undefined) {
    elapsedHours = parseNonNegativeInt(
      flags["elapsed-hours"],
      "--elapsed-hours",
    );
  } else {
    process.stdout.write(bold("How many hours have already elapsed? "));
    const answer = await prompt("");
    elapsedHours = parseNonNegativeInt(answer, "elapsed hours");
  }

  // Validate: elapsed cannot exceed total.
  if (elapsedHours > totalDurationHours) {
    throw new Error(
      `Elapsed time (${elapsedHours}h) cannot exceed total duration (${totalDurationHours}h).`,
    );
  }

  const remainingHours = totalDurationHours - elapsedHours;
  if (remainingHours <= 0) {
    throw new Error(
      "No time remaining: elapsed time equals or exceeds total duration.",
    );
  }
  if (remainingHours < 1) {
    process.stderr.write(
      yellow(`WARNING: Only ${remainingHours} hour(s) remain. The hackathon is nearly over.\n`),
    );
  }

  // --- Question 3: Number of teammates ---
  if (flags.teammates !== undefined) {
    teammateCount = parsePositiveInt(flags.teammates, "--teammates");
  } else {
    process.stdout.write(
      bold("How many teammates will connect to this Admin PC? (exclude the Admin) "),
    );
    const answer = await prompt("");
    teammateCount = parsePositiveInt(answer, "teammate count");
  }

  return new SessionInputs({
    totalDurationHours,
    elapsedHours,
    teammateCount,
    remainingHours,
  });
}

/**
 * Render the calculated session budget for user review.
 *
 * Returns an array of display lines.
 */
export function renderSessionSummary({
  totalDurationHours,
  elapsedHours,
  remainingHours,
  teammateCount,
  _reserveFraction = 0.1,
  workerBudgetHours,
  reserveHours,
}) {
  const lines = [];
  lines.push(bold("Hackathon session configuration"));
  lines.push("");
  lines.push(`  Total duration:   ${dim(`${totalDurationHours} hours`)}`);
  lines.push(`  Elapsed time:     ${dim(`${elapsedHours} hours`)}`);
  lines.push(`  Remaining time:   ${dim(`${remainingHours} hours`)}`);
  lines.push(`  Teammates:        ${dim(`${teammateCount} (excludes Admin PC)`)}`);
  lines.push(`  Total machines:   ${dim(`${teammateCount + 1} including Admin`)}`);
  lines.push("");
  lines.push(bold("Time budget"));
  lines.push(`  Worker execution budget:    ${dim(`${Math.round(workerBudgetHours)} hours`)}`);
  lines.push(`  Integration/fix/reserve:    ${dim(`${Math.round(reserveHours)} hours`)}`);
  lines.push("");
  lines.push(dim("Review the values above. Session creation will use these exact values."));
  return lines;
}

export default {
  prompt,
  parseNonNegativeInt,
  parsePositiveInt,
  SessionInputs,
  collectSessionInputs,
  renderSessionSummary,
};
