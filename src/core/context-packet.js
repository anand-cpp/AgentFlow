// Context packet: a structured, portable record of one session's work.
//
// Where buildAgentContext produces the live prompt for a running agent, a context
// packet is the record handed to a *new* provider process when the previous one
// fails, is interrupted, or hands off mid-task. It is assembled from the same
// authoritative stores -- the Session and the Blackboard -- but shaped so a fresh
// model can continue the work instead of re-deriving it.
//
// Design constraints, in priority order:
//
//  1. Never invent. Every field comes from a store, or is absent. A packet that
//     claims "all work is done" while the stores disagree is worse than one that
//     says nothing about completion. Each packet records which sources existed,
//     so a reader knows what it was allowed to know.
//
//  2. Truncation must report itself, and never lie about its own certainty. When
//     a reliable context window is declared it is honoured; otherwise a plain
//     character budget is used; when neither exists the packet carries no limit
//     claim at all rather than presenting an unknown limit as known.
//
//  3. Deterministic. Same stores, same options, same packet -- a resumed process
//     gets the same view and a test can assert on the output.
//
//  4. Frozen. Nothing downstream may mutate the packet a continuation was built
//     on. Frozen is the cheapest way to make a mutation a bug instead of a
//     possibility.

import { redactDeep } from "./redact.js";

export const CONTEXT_PACKET_VERSION = 1;

/** Where the character limit came from. "unknown" must never be styled as known. */
export const CONTEXT_LIMIT_SOURCE = {
  MODEL_WINDOW: "model_window",
  AGENT_BUDGET: "agent_budget",
  UNKNOWN: "unknown",
};

export class ContextPacketError extends Error {
  constructor(message, code = "context_packet_error") {
    super(message);
    this.name = "ContextPacketError";
    this.code = code;
  }
}

// Priority order when the budget runs out. The current task outranks everything
// because a continuation that loses the objective will invent one; unresolved
// work comes next for the same reason the intent fields come first in context.js.
// Newest-first within each group, matching context.js: the most recent evidence
// is usually the one in force.
const SECTIONS = [
  { key: "nextActions", priority: 95 },
  { key: "conversation", priority: 90 },
  { key: "toolOutcomes", priority: 85 },
  { key: "commands", priority: 80 },
  { key: "testResults", priority: 75 },
  { key: "providers", priority: 70 },
  { key: "assumptions", priority: 60 },
  { key: "questions", priority: 55 },
  { key: "blockers", priority: 50 },
  { key: "decisions", priority: 45 },
  { key: "bugs", priority: 40 },
  { key: "findings", priority: 35 },
  { key: "files", priority: 20 },
  { key: "commits", priority: 15 },
  { key: "checkpoints", priority: 10 },
];

// These sections are the contract of the packet. If they cannot be carried,
// the packet is not worth building: a continuation that loses its identity or
// its task is no longer a continuation of this work.
const CORE_SECTIONS = ["identity", "task", "metadata"];

function sizeOf(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Freeze the whole tree, not just the top level.
 *
 * A shallow freeze leaves nested arrays and objects mutable, which is exactly
 * where a downstream "fix-up" would reach for the packet a continuation was
 * built on. A mutation of nested state is the failure this guards against, so
 * the freeze has to be as deep as the data.
 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const v of Object.values(value)) deepFreeze(v, seen);
  return Object.freeze(value);
}

function toArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function compactTask(task) {
  if (typeof task === "string") return { title: task };
  if (!task || typeof task !== "object") return null;
  const out = {};
  for (const k of ["id", "title", "detail", "status", "taskId"]) {
    if (task[k] !== undefined) out[k] = task[k];
  }
  return Object.keys(out).length ? out : { title: String(task) };
}

function readBlackboard(store) {
  if (!store) return { present: false, summary: null };
  if (typeof store.exists === "function" && !store.exists()) {
    return { present: false, summary: null };
  }
  const summary = typeof store.get === "function" ? store.get() : store.summary?.();
  if (!summary) return { present: false, summary: null };
  return { present: true, summary };
}

/** Compact view of one session entry, shaped per kind. */
function compactEntry(entry) {
  // SessionStore spreads the payload into the entry's top level; `entry.payload`
  // is tolerated for callers that pre-shape an entry object.
  const p = entry.payload || entry;
  switch (entry.kind) {
    case "conversation":
      // role/text are the shapes the runtime writes; content is tolerated for
      // stores written before those settled.
      return { role: p.role ?? p.sender ?? "user", text: p.text ?? p.content ?? null };
    case "note":
      return { note: p.text ?? null };
    case "tool_call":
      return {
        tool: p.tool ?? null,
        scope: p.scope ?? null,
        status: p.status ?? "called",
        truncated: p.truncated ?? null,
        summary: p.summary ?? null,
      };
    case "tool_result":
      return {
        tool: p.tool ?? null,
        scope: p.scope ?? null,
        agent: p.agent ?? null,
        status: p.status ?? null,
        permission: p.permission ?? null,
        truncated: p.truncated ?? null,
        summary: p.summary ?? null,
        errorCode: p.errorCode ?? null,
      };
    case "routing":
      return {
        provider: p.provider ?? ((p.modelId || p.model || "").split("/")[0] || null),
        model: p.model ?? p.modelId ?? p.userModelId ?? null,
        outcome: p.outcome ?? p.decision ?? null,
      };
    case "checkpoint":
      return { checkpoint: p.title ?? p.path ?? p.note ?? null, at: entry.ts };
    case "agent":
      return {
        agent: p.agentId ?? null,
        state: p.state ?? null,
        completed: p.completed ?? null,
        iterations: p.iterations ?? null,
      };
    case "error":
      return { error: p.message ?? p.error ?? null };
    default:
      return { kind: entry.kind, at: entry.ts };
  }
}

/**
 * Assemble the context packet from authoritative stores.
 *
 * `session` is a parsed Session document, not a store (no locks or reads
 * happen here). `blackboard` is a store or summary object; a summary is enough
 * and avoids requiring write access to build a read-only packet.
 */
export function buildContextPacket({
  session = null,
  blackboard = null,
  task = null,
  extra = null,
  agentId = null,
  now = null,
} = {}) {
  const board = readBlackboard(blackboard);
  const summary = board.summary || {};
  const sessionValid = session && typeof session.id === "string";

  const entries = sessionValid && Array.isArray(session.entries) ? session.entries : [];
  const fromSession = (kind) => entries.filter((e) => e.kind === kind).map(compactEntry);
  const recent = (list, n) => toArray(list).slice(-n);

  const toolOutcomes = fromSession("tool_result");
  // Derived from a fresh read, not `toolOutcomes.filter(...)`: sharing element
  // references would make redactDeep (which flags any repeat ref as "[circular]")
  // replace the second sighting with the literal string. Independent objects keep
  // both sections intact after redaction.
  const commands = fromSession("tool_result").filter((t) => t.tool === "shell.execute");
  const providerHistory = fromSession("routing");

  const packet = {
    version: CONTEXT_PACKET_VERSION,
    identity: {
      agentId: agentId ?? null,
      // Named `session`, not `sessionId`: the redactor masks any key matching
      // session[_-]?id (it guards session tokens), so a field called sessionId
      // would be replaced by "***" on both the in-memory and persisted packet.
      // The value here is the session document's id, which is not a secret.
      session: sessionValid ? session.id : null,
      blackboardId: summary.id ?? null,
      taskId: task?.taskId ?? null,
      workspaceRoot: session?.project?.root ?? summary.projectRoot ?? null,
    },
    task: {
      objective: sessionValid ? session.objective ?? null : null,
      state: sessionValid ? session.state ?? null : null,
      completedAt: sessionValid ? session.completedAt ?? null : null,
      task: task ? compactTask(task) : null,
      extra: extra === null || extra === undefined ? null : extra,
    },
    nextActions: {
      nextAction: summary.nextAction ?? null,
      inProgress: recent(summary.inProgress, 5),
      openTasks: recent(summary.openTasks, 10),
    },
    conversation: recent(fromSession("conversation").concat(fromSession("note")), 40),
    toolOutcomes: recent(toolOutcomes, 30),
    commands: recent(commands, 20),
    testResults: recent(summary.latestTests, 10),
    providers: {
      current: {
        provider: sessionValid ? session.provider ?? null : null,
        model: sessionValid ? session.model ?? null : null,
      },
      history: recent(providerHistory, 10),
    },
    assumptions: recent(summary.activeAssumptions, 5),
    questions: recent(summary.openQuestions, 5),
    blockers: recent(summary.openBlockers, 5),
    decisions: recent(summary.activeDecisions, 8),
    bugs: recent(summary.openBugs, 8),
    findings: recent(summary.openFindings, 8),
    files: recent(summary.files, 20),
    commits: recent(summary.commits, 10),
    checkpoints: recent(fromSession("checkpoint"), 10),
    metadata: {
      builtAt: now ? new Date(now).toISOString() : new Date().toISOString(),
      sources: {
        session: Boolean(sessionValid),
        blackboard: board.present,
        task: Boolean(task),
      },
      errors: {
        session: sessionValid ? null : "absent",
        blackboard: board.present ? null : "absent",
      },
      limitSource: CONTEXT_LIMIT_SOURCE.UNKNOWN,
      limit: null,
      budget: null,
      reserveChars: 0,
      truncated: {},
    },
  };

  // Everything a model can see passes through redactDeep, mirroring context.js.
  // The stores already redact on write; this is the second line for a caller
  // that assembled raw data without going through a store. The deep freeze is
  // applied to the redacted copy so no reference into it stays mutable.
  return deepFreeze(redactDeep(packet));
}

/**
 * Fit a packet inside a character limit.
 *
 * `contextWindow` is a declared model context window in characters (the unit of
 * this module -- a token-typed window must be converted by the caller, because
 * guessing a token-to-char ratio here would be exactly the sort of claimed
 * precision this module refuses to add). `reserveChars` covers the system
 * prompt, request headers, tool schemas and the response budget a caller expects
 * to leave unfilled. `budgetChars` is the fallback when no window is declared:
 * the agent's own bounds.maxContextChars, for example.
 *
 * When neither is given the packet is returned with limitSource "unknown" and
 * no truncation applied. That is not silence about a limitation -- it is the
 * honest relay of "we do not know the model's window", which must never be
 * styled as a known one.
 */
export function budgetContextPacket(
  packet,
  { contextWindow = null, reserveChars = 0, budgetChars = null } = {},
) {
  const reserve = Math.max(0, Number.isFinite(reserveChars) ? Math.round(reserveChars) : 0);
  let limit = null;
  let limitSource = CONTEXT_LIMIT_SOURCE.UNKNOWN;

  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    limit = Math.max(0, Math.round(contextWindow) - reserve);
    limitSource = CONTEXT_LIMIT_SOURCE.MODEL_WINDOW;
  } else if (Number.isFinite(budgetChars) && budgetChars > 0) {
    limit = Math.round(budgetChars);
    limitSource = CONTEXT_LIMIT_SOURCE.AGENT_BUDGET;
  }

  if (limit === null) {
    return deepFreeze({
      ...packet,
      metadata: {
        ...packet.metadata,
        limitSource: CONTEXT_LIMIT_SOURCE.UNKNOWN,
        limit: null,
        budget: null,
        reserveChars: reserve,
        truncated: {},
        incomplete: false,
      },
    });
  }

  const fit = fitSections(packet, limit, reserve, limitSource);
  return deepFreeze(fit);
}

/**
 * The deterministic fit. Core sections always survive; the rest are whole-or-
 * dropped, with arrays kept newest-first (like context.js, because a resolved
 * blocker from weeks ago is noise). Every decision is counted in truncated, so
 * a reader can tally what they were not shown.
 */
function fitSections(packet, limit, reserve, limitSource) {
  const truncated = {};
  const kept = {};
  let used = 0;

  for (const key of CORE_SECTIONS) {
    const value = packet[key];
    const cost = sizeOf(value);
    kept[key] = value === undefined ? null : value;
    used += cost;
  }

  // The core is the packet's contract. If it cannot fit, name the number rather
  // than silently shipping a packet that misplaces its own identity and task.
  if (used > limit) {
    throw new ContextPacketError(
      `context packet core (${used} chars) exceeds the ${limit}-char budget; ` +
        `raise the model contextWindow/reserveChars or the agent budget`,
      "budget_too_small",
    );
  }

  for (const section of SECTIONS) {
    const raw = packet[section.key];
    if (raw === null || raw === undefined) continue;
    const cost = sizeOf(raw);

    if (used + cost <= limit) {
      kept[section.key] = raw;
      used += cost;
      continue;
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      truncated[section.key] = "dropped";
      continue;
    }

    // Newest-first within an array, like context.js. Count what was omitted so
    // the reader is told.
    let taken = 0;
    const keptItems = [];
    for (let i = raw.length - 1; i >= 0; i--) {
      const itemCost = sizeOf(raw[i]) + 1;
      if (used + itemCost > limit) break;
      keptItems.unshift(raw[i]);
      used += itemCost;
      taken += 1;
    }
    if (taken > 0) kept[section.key] = keptItems;
    if (taken < raw.length) truncated[section.key] = raw.length - taken;
  }

  const incomplete = Object.keys(truncated).length > 0;
  return {
    ...kept,
    metadata: {
      ...packet.metadata,
      limit,
      limitSource,
      budget: limit,
      reserveChars: reserve,
      truncated,
      incomplete,
    },
  };
}

/**
 * Render the packet as a text block a model can read.
 *
 * Kept separate from assembly so the caller can render several ways and tests
 * can assert on the rendering. When the packet was truncated, the omissions are
 * named -- a continuation must know it is looking through a window.
 */
export function renderContextPacket(packet) {
  const lines = [];
  const push = (label, value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return;
    if (Array.isArray(value) && value.length === 0) return;
    lines.push(`${label}:`);
    lines.push(typeof value === "string" ? `  ${value}` : `  ${JSON.stringify(value)}`);
  };

  push("session id", packet?.identity?.session);
  push("workspace root", packet?.identity?.workspaceRoot);
  push("task", packet?.task?.objective);
  push("task state", packet?.task?.state);
  push("next actions", packet?.nextActions);
  push("conversation", packet?.conversation);
  push("tool outcomes", packet?.toolOutcomes);
  push("commands", packet?.commands);
  push("test results", packet?.testResults);
  push("providers", packet?.providers);
  push("open blockers", packet?.blockers);
  push("open questions", packet?.questions);
  push("assumptions", packet?.assumptions);
  push("decisions", packet?.decisions);
  push("bugs", packet?.bugs);
  push("findings", packet?.findings);
  push("files", packet?.files);
  push("commits", packet?.commits);
  push("checkpoints", packet?.checkpoints);

  const truncated = packet?.metadata?.truncated ?? {};
  if (Object.keys(truncated).length) {
    const detail = Object.entries(truncated)
      .map(([k, n]) => (n === "dropped" ? `${k} (dropped)` : `${k} (${n} omitted)`))
      .join(", ");
    lines.push("");
    lines.push(`note: this context packet is incomplete. Omitted for budget: ${detail}.`);
    lines.push("Ask for what you need rather than assuming it is absent.");
  } else if (packet?.metadata?.budget !== null && packet?.metadata?.budget !== undefined) {
    lines.push("");
    lines.push(`note: context packet fit within its ${packet.metadata.budget}-char budget (${packet.metadata.limitSource}).`);
  }

  return lines.join("\n");
}

// Restate the section table for callers that want the priorities, and provide a
// stable export for consumers that prefer named keys over walking SECTIONS.
export const CONTEXT_SECTION_KEYS = CORE_SECTIONS.concat(SECTIONS.map((s) => s.key));

/** Total character cost of the (already budgeted) packet. */
export function packetSize(packet) {
  return sizeOf(packet);
}

export default {
  CONTEXT_PACKET_VERSION,
  CONTEXT_LIMIT_SOURCE,
  CONTEXT_SECTION_KEYS,
  ContextPacketError,
  buildContextPacket,
  budgetContextPacket,
  renderContextPacket,
  packetSize,
};