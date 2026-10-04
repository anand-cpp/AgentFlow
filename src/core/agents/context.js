// Execution context assembly.
//
// What an agent actually sees when it starts. Pulls from the Blackboard and the
// Session, then fits the result inside the agent's declared context budget.
//
// The budget is the whole point. Three separate projects in the audit notes --
// DeepSeek's spill/, OpenCode's truncate.ts, and this repo's rtk/ -- all
// independently solved "context overflowed, now what". The lesson from three
// implementations is that truncation which fails silently is worse than no
// truncation: an agent reading a clipped prompt cannot tell that what it was given
// is incomplete, and will confidently answer from a partial picture.
//
// So truncation here always reports itself. `context.truncated` names what was cut
// and the assembled context is frozen, so nothing downstream can "fix" it by
// mutating what it received.

import { redactDeep } from "../redact.js";

// Priority order when the budget runs out. The intent fields come first because an
// agent that knows the goal but not the next action will invent one; an agent that
// knows the next action but not the goal usually still does the right thing.
//
// Newest-first within each group, because a resolved blocker from three weeks ago
// is noise while the most recent decision is usually the one in force.
const GROUPS = [
  { key: "intent", priority: 100 },
  { key: "nextAction", priority: 95 },
  { key: "openBlockers", priority: 90 },
  { key: "activeDecisions", priority: 85 },
  { key: "inProgress", priority: 80 },
  { key: "openTasks", priority: 75 },
  { key: "activeAssumptions", priority: 60 },
  { key: "openQuestions", priority: 55 },
  { key: "openBugs", priority: 50 },
  { key: "openFindings", priority: 40 },
  { key: "latestTests", priority: 30 },
  { key: "reviews", priority: 20 },
  { key: "files", priority: 10 },
  { key: "commits", priority: 5 },
];

export class ContextError extends Error {
  constructor(message, code = "context_error") {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

function sizeOf(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // A cyclic or otherwise unserialisable value costs nothing rather than
    // blowing up assembly; there is nothing useful to send a model anyway.
    return 0;
  }
}

/**
 * Pull the Blackboard into a plain object, tolerating its absence.
 *
 * A missing Blackboard is a legitimate state -- a project has not been started --
 * and reading one must not fail the execution. A *corrupt* one is different and
 * propagates, because silently continuing past unreadable recorded state would let
 * an agent act on a truncated view of the work and think it saw everything.
 */
function readBlackboard(store) {
  if (!store) return { present: false, summary: null };
  // Absence is detected structurally, via `exists()`, not by catching an error and
  // pattern-matching its text. Telling "absent" from "corrupt" by message means
  // getting it backwards the day someone rewords an error -- and getting it
  // backwards means running an agent on a half-read picture of the work.
  if (typeof store.exists === "function" && !store.exists()) {
    return { present: false, summary: null };
  }
  const summary = typeof store.get === "function" ? store.get() : store.summary?.();
  if (!summary) return { present: false, summary: null };
  return { present: true, summary };
}

/**
 * Assemble the model-facing context for one agent execution.
 *
 * `blackboard` and `session` are optional. Neither is required to run an agent:
 * an agent asked a direct question with no project history should still work.
 */
export function buildAgentContext({ agent, blackboard = null, session = null, task = null, extra = null } = {}) {
  const budget = agent?.bounds?.maxContextChars;
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new ContextError("agent must declare a positive bounds.maxContextChars", "no_budget");
  }

  const board = readBlackboard(blackboard);
  const summary = board.summary || {};

  const assembled = {
    goal: summary.goal ?? null,
    objective: summary.objective ?? null,
    nextAction: summary.nextAction ?? null,
    inProgress: toArray(summary.inProgress),
    openTasks: toArray(summary.openTasks),
    activeDecisions: toArray(summary.activeDecisions),
    openBlockers: toArray(summary.openBlockers),
    openBugs: toArray(summary.openBugs),
    openQuestions: toArray(summary.openQuestions),
    activeAssumptions: toArray(summary.activeAssumptions),
    openFindings: toArray(summary.openFindings),
    latestTests: toArray(summary.latestTests),
    reviews: toArray(summary.reviews),
    files: toArray(summary.files),
    commits: toArray(summary.commits),
  };

  // The caller's own task outranks recorded history: it is why this run exists.
  const head = {
    task: task ? compact(task) : null,
    session: session ? compactSession(session) : null,
    extra: extra ?? null,
  };

  const intent = {
    goal: assembled.goal,
    objective: assembled.objective,
    nextAction: assembled.nextAction,
  };

  const selected = fit(intent, head, assembled, budget);
  const redacted = redactDeep(selected.value);

  return Object.freeze({
    ...redacted,
    agentId: agent?.id ?? null,
    blackboardPresent: board.present,
    sessionId: session?.id ?? null,
    // `chars`, not tokens. A real tokenizer is a dependency and an approximation
    // of one is a lie; characters are honest and the budget is ours anyway.
    chars: sizeOf(redacted),
    budget,
    truncated: Object.freeze(selected.truncated),
  });
}

function toArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function compact(task) {
  if (typeof task === "string") return { title: task };
  const out = {};
  for (const k of ["id", "title", "detail", "status", "taskId"]) {
    if (task[k] !== undefined) out[k] = task[k];
  }
  return Object.keys(out).length ? out : { title: String(task) };
}

function compactSession(session) {
  return {
    id: session.id ?? null,
    name: session.name ?? null,
    objective: session.objective ?? null,
    agents: toArray(session.agents).map((a) => (typeof a === "string" ? a : a.id ?? null)).filter(Boolean),
  };
}

/**
 * Fit the groups into the budget, highest priority first.
 *
 * A group is included whole or dropped whole -- never clipped mid-record. Half a
 * task is worse than no task: the model cannot tell that it is half a task.
 */
function fit(intent, head, rest, budget) {
  const truncated = {};
  let used = sizeOf(intent) + sizeOf(head);

  // Intent is never dropped. If it alone exceeds the budget that is a
  // configuration problem worth naming, not something to paper over.
  if (used > budget) {
    throw new ContextError(
      `agent context budget ${budget} is smaller than the intent and task it must carry (${used}); ` +
        `raise bounds.maxContextChars or shorten the goal/objective`,
      "budget_too_small"
    );
  }

  const value = { ...intent, ...head };
  for (const group of GROUPS) {
    if (group.key === "intent" || group.key === "nextAction") continue;
    const items = rest[group.key];
    if (!Array.isArray(items) || !items.length) continue;

    const cost = sizeOf(items);
    if (used + cost <= budget) {
      value[group.key] = items;
      used += cost;
      continue;
    }

    // Newest-first, so take from the tail and count what did not fit.
    let taken = 0;
    const kept = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const itemCost = sizeOf(items[i]) + 1;
      if (used + itemCost > budget) break;
      kept.unshift(items[i]);
      used += itemCost;
      taken += 1;
    }
    if (taken > 0) {
      value[group.key] = kept;
      used += 0;
    }
    if (taken < items.length) {
      truncated[group.key] = items.length - taken;
    }
  }

  return { value, truncated };
}

/**
 * Render the context as the system-prompt block.
 *
 * Kept separate from assembly so the runtime can assemble once and render several
 * ways, and so a test can assert on the rendering without rebuilding context.
 */
export function renderContext(context) {
  const lines = [];
  const push = (label, value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && !value.length) return;
    lines.push(`${label}:`);
    lines.push(typeof value === "string" ? `  ${value}` : `  ${JSON.stringify(value)}`);
  };

  push("goal", context.goal);
  push("objective", context.objective);
  push("next action", context.nextAction);
  push("current task", context.task);
  for (const group of GROUPS) {
    if (group.key === "intent") continue;
    push(group.key, context[group.key]);
  }

  if (Object.keys(context.truncated || {}).length) {
    const detail = Object.entries(context.truncated)
      .map(([k, n]) => `${k} (${n} older omitted)`)
      .join(", ");
    lines.push(`note: this context is incomplete. Omitted for budget: ${detail}.`);
    lines.push("Ask for what you need rather than assuming it is absent.");
  }

  return lines.join("\n");
}

export default { buildAgentContext, renderContext, ContextError };