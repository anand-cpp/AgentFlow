// The bounded agent runtime.
//
// Executes one agent against one task, with hard limits and an honest outcome.
//
// Design commitments, each of which exists because its absence has a specific bad
// day attached to it:
//
//   Bounded.      Iterations, tool calls, wall clock and recursion depth are all
//                 capped. An agent loop without caps is a fork bomb with a token bill.
//   Orthogonal.   timeout / cancelled / failed are independent flags. Nesting them
//                 is how a run that got cut short reports clean success.
//   Boring.       The agent loop is a plain function composition over the model and
//                 the tool pipeline. Nothing here is clever, because the clever
//                 part belongs in the model and the harness study already settled
//                 the hard parts.
//
// This module orchestrates. It does not select models (requirements.js), judge
// permissions (tools.js), or build prompts (context.js). Each of those owns one
// decision so there is a single place to look when the answer is wrong.

import { Router } from "../routing.js";
import { EVENTS } from "../events.js";
import { ENTRY_KIND } from "../sessions.js";
import { resolveModelPlan, explainPlan } from "./requirements.js";
import { buildAgentContext, renderContext, ContextError } from "./context.js";
import { runTool, OUTCOME } from "./tools.js";
import { AgentError, AgentNotFoundError } from "./registry.js";

/**
 * Terminal and non-terminal states.
 *
 * `TIMED_OUT` and `CANCELLED` are terminal but are *also* recorded on the result as
 * orthogonal booleans, so a caller can ask "did it finish?" and "was it cut off?"
 * as separate questions. Nesting them -- `cancelled: { timedOut: true }` -- is the
 * documented defect class in the harness study, and it is easy to write by accident.
 */
export const STATE = {
  CREATED: "created",
  CONTEXT_LOADING: "context_loading",
  READY: "ready",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
};

export class RuntimeError extends Error {
  constructor(message, code = "runtime_error", details = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class AgentTimeoutError extends RuntimeError {
  constructor(ms) {
    super(`agent exceeded its ${ms}ms budget`, "agent_timeout", { timeoutMs: ms });
    this.name = "AgentTimeoutError";
  }
}

export class AgentCancelledError extends RuntimeError {
  constructor(reason = "cancelled by caller") {
    super(reason, "agent_cancelled");
    this.name = "AgentCancelledError";
  }
}

export class AgentBoundError extends RuntimeError {
  constructor(bound, limit, value) {
    super(`agent hit its ${bound} limit of ${limit}`, "agent_bound_exceeded", { bound, limit, value });
    this.name = "AgentBoundError";
  }
}

/**
 * The agent runtime.
 *
 * Collaborators are injected, never constructed internally. That is what makes the
 * whole thing testable without a provider, a network, or a real agent loop -- and
 * it is also what lets the CLI and a future daemon share one runtime.
 */
export class AgentRuntime {
  constructor({
    registry,
    tools = new Map(),
    // `(config, modelId, prompt, opts) -> {text}` -- the gateway's complete().
    complete = null,
    catalogue = [],
    hints = {},
    log = null,
    now = () => Date.now(),
    approver = null,
    blackboard = null,
    sessions = null,
    guards = [],
    config = null,
  } = {}) {
    if (!registry) throw new RuntimeError("AgentRuntime requires a registry", "no_registry");
    if (typeof complete !== "function") {
      throw new RuntimeError("AgentRuntime requires a complete function", "no_complete");
    }
    this.registry = registry;
    this.tools = tools instanceof Map ? tools : new Map(Object.entries(tools || {}));
    this.complete = complete;
    this.catalogue = catalogue;
    this.hints = hints;
    this.now = now;
    this.approver = approver;
    this.blackboard = blackboard;
    this.sessions = sessions;
    this.guards = guards;
    this.config = config;
    // Wrapped once, here, and the wrapper is what everything downstream uses --
    // including the Router, which emits route events outside its own try/catch.
    // Logging is observability; a broken logger must not decide whether an agent
    // run succeeds.
    this.log = safeLog(log);
  }

  /**
   * Extract tool calls a completion asked for.
   *
   * Deliberately shape-tolerant rather than protocol-specific. Providers disagree
   * about how tool calls arrive -- OpenAI-style `tool_calls`, a plain JSON body, a
   * fenced block -- and the runtime should not care which. What it must care about
   * is that an unparseable request yields no calls rather than a guess, because a
   * guessed tool call is an unauthorised command.
   */
  parseToolCalls(value) {
    const raw = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    if (raw.length) return raw.map((c) => ({ tool: c.tool ?? c.name, args: c.args ?? c.arguments ?? {} }));

    // A JSON body that describes calls, which is the common convention for
    // providers without a native tool API.
    const text = typeof value === "string" ? value : value?.text;
    if (!text) return [];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text).trim();
    if (!candidate.startsWith("{")) return [];
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return [];
    }
    const calls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];
    return calls
      .filter((c) => c && typeof (c.tool ?? c.name) === "string")
      .map((c) => ({ tool: c.tool ?? c.name, args: c.args ?? c.arguments ?? {} }));
  }

  /**
   * Execute the tool calls a model asked for.
   *
   * Returns a denial reason to stop the loop, or null to continue. Results are
   * appended to the transcript FIFO, after the completion that requested them --
   * the harness study is explicit that tool-observed content belongs after the
   * transcript record, in order.
   */
  async runRequestedTools(calls, { agent, result, signal, startedAt, transcript, emit }) {
    for (const call of calls) {
      // Checked before the increment, not after, so a reported tool-call count can
      // never exceed the cap it was held to. Checking afterwards means the number
      // the operator sees is one larger than the limit they configured, which reads
      // as the bound being wrong rather than as the bound working.
      if (result.toolCalls >= agent.bounds.maxToolCalls) {
        throw new AgentBoundError("maxToolCalls", agent.bounds.maxToolCalls, result.toolCalls);
      }
      result.toolCalls += 1;
      this.guard(agent, result, signal, startedAt);

      const tool = this.tools.get(call.tool);
      if (!tool) {
        const reason = `no such tool: ${call.tool}`;
        emit(EVENTS.AGENT_TOOL_REQUESTED, { agentId: agent.id, tool: call.tool, known: false }, "warn");
        return reason;
      }

      emit(EVENTS.AGENT_TOOL_REQUESTED, { agentId: agent.id, tool: call.tool, scope: tool.scope });
      const outcome = await runTool(agent, tool, call, {
        preExecute: agent.lifecycle?.prepare ? [agent.lifecycle.prepare] : [],
        guards: this.guards,
        approver: this.approver,
        log: this.log,
        signal,
        now: this.now,
      });

      result.toolResults.push(outcome);
      emit(EVENTS.AGENT_TOOL_COMPLETED, {
        agentId: agent.id,
        tool: call.tool,
        outcome: outcome.outcome,
        approved: outcome.approved,
      });
      agent.lifecycle?.onToolResult?.(outcome, { agent, result });

      if (outcome.outcome === OUTCOME.DENIED) {
        return outcome.error?.message || `tool ${call.tool} was denied`;
      }

      transcript.push({ role: "tool", tool: call.tool, output: outcome.output, contexts: outcome.contexts });
    }
    return null;
  }

  /** Resolve an agent by id, with the registry's "known agents" hint. */
  resolve(id) {
    if (!this.registry) throw new RuntimeError("no registry", "no_registry");
    const known = typeof this.registry.ids === "function" ? this.registry.ids() : [];
    const agent = this.registry.get(id);
    if (!agent) throw new AgentNotFoundError(id, known);
    return agent;
  }

  /**
   * Run one agent against one task.
   *
   * Never throws for an execution failure. Every outcome -- including timeout,
   * cancellation and a provider cascade that exhausted itself -- comes back as a
   * result object. A caller that has to catch four exception types to learn that
   * the agent stopped will eventually handle one of them wrong.
   */
  async run({ agentId, task = null, sessionId = null, signal = null, extra = null, depth = 0 } = {}) {
    const startedAt = this.now();
    const id = String(agentId ?? "").trim();
    // Declared out here so the catch path can name the agent even when the failure
    // was resolving it.
    let agent = null;

    const result = {
      agentId: id,
      task: task ? compactTask(task) : null,
      sessionId: sessionId ?? null,
      state: STATE.CREATED,
      // Orthogonal by design. See the note on STATE above.
      completed: false,
      timedOut: false,
      cancelled: false,
      iterations: 0,
      toolCalls: 0,
      depth,
      maxDepth: agent ? agent.bounds.maxDepth : null,
      model: null,
      plan: null,
      output: null,
      toolResults: [],
      // Every state the run passed through, not just the final one.
      states: [],
      error: null,
      events: [],
      startedAt,
      finishedAt: null,
    };

    const emit = (type, payload = {}, level = "info") => {
      result.events.push({ type, ...payload });
      try {
        this.log.emit(type, payload, level);
      } catch {
        /* a broken logger must not take the run down */
      }
    };

    try {
      // Resolution is inside the try so an unknown agent is a result, not a throw.
      // "That agent does not exist" is an ordinary outcome of a CLI invocation, and
      // a caller forced to catch it separately will forget.
      agent = this.resolve(id);
      const bounds = agent.bounds;

      // Recursion depth, checked before any work happens rather than at the end.
      // An agent that delegates to another agent is a bounded recursion, and the
      // bound has to be a real number the caller can rely on rather than a comment
      // saying "avoid infinite loops".
      if (depth > bounds.maxDepth) {
        throw new AgentBoundError("maxDepth", bounds.maxDepth, depth);
      }

      // --- context -------------------------------------------------------
      this.transition(result, STATE.CONTEXT_LOADING, agent);
      let session = null;
      if (sessionId && this.sessions) {
        // Checked rather than assumed. Calling a missing method gives an opaque
        // TypeError a long way from the wiring mistake that caused it, and quietly
        // skipping the read would hide the same mistake behind a context that is
        // silently missing the session's objective.
        if (typeof this.sessions.read !== "function") {
          throw new RuntimeError(
            "a sessionId was given but the sessions collaborator has no read()",
            "bad_sessions"
          );
        }
        session = this.sessions.read(sessionId);
      }
      const context = buildAgentContext({
        agent,
        blackboard: this.blackboard,
        session,
        task,
        extra,
      });
      result.context = context;
      emit(EVENTS.AGENT_CONTEXT_LOADED, {
        agentId: agent.id,
        chars: context.chars,
        budget: context.budget,
        truncated: context.truncated,
        blackboard: context.blackboardPresent,
      });

      // --- routing -------------------------------------------------------
      // The model plan is resolved before the loop because a resolvable plan is
      // cheap and an unresolvable one should fail before anything is dispatched.
      const plan = resolveModelPlan(agent, { catalogue: this.catalogue, hints: this.hints });
      result.plan = plan;
      // Deliberately *not* AGENT_MODEL_SELECTED. Nothing has been selected yet --
      // this is the candidate set. The event that claims a model was chosen is
      // emitted below, after the Router returns a winner. Emitting "selected" here
      // meant the log recorded a selection that could then contradict the receipt.
      emit(EVENTS.AGENT_ROUTE_PLANNED, {
        agentId: agent.id,
        pinned: plan.pinned,
        candidates: plan.candidates,
        reason: explainPlan(plan),
      });

      // The agent's own retry budget, applied to the cascade. The Router bounds
      // itself by the candidate list it is given, which is not the same thing: an
      // agent declaring `maxRetries: 0` means "do not try a second provider on its
      // own initiative", and a 40-model catalogue would otherwise have retried
      // forty times against a declaration of zero.
      //
      // `routing.maxAttempts: 0` means unset rather than "none" -- it is the
      // registry default, and reading it as a hard zero would silently disable
      // provider fallback for every agent that did not think to set it.
      const byRetries = agent.failure.maxRetries + 1;
      const maxAttempts =
        agent.routing.maxAttempts > 0 ? Math.min(agent.routing.maxAttempts, byRetries) : byRetries;
      const tiers =
        maxAttempts >= plan.tiers.reduce((n, t) => n + t.models.length, 0)
          ? plan.tiers
          : capTiers(plan.tiers, maxAttempts);

      // One router for the whole execution. `currentPrompt` is read by the execute
      // closure, which is safe because `route()` is awaited before it changes
      // again -- and building a Router per iteration would throw away its health
      // memory, so a retry loop would keep re-trying a provider that just failed.
      let currentPrompt = buildPrompt(agent, context, task, 1);
      const router = new Router({
        tiers,
        execute: (modelId, { signal: s }) =>
          this.complete(this.config, modelId, currentPrompt, {
            timeoutMs: bounds.timeoutMs,
            system: renderSystemPrompt(agent, context),
            maxTokens: agent.model.maxTokens,
            temperature: agent.model.temperature,
            signal: s,
          }),
        log: this.log,
        now: this.now,
      });

      // --- loop ----------------------------------------------------------
      this.transition(result, STATE.RUNNING, agent);
      emit(EVENTS.AGENT_START, { agentId: agent.id, bounds });

      const transcript = [];
      let output = null;

      for (let iteration = 1; iteration <= bounds.maxIterations; iteration++) {
        result.iterations = iteration;
        this.guard(agent, result, signal, startedAt);

        currentPrompt = buildPrompt(agent, context, task, iteration, transcript);

        const receipt = await router.route({
          signal,
          onAttempt: (record) => emit(EVENTS.AGENT_RETRYING, { agentId: agent.id, ...record }, "warn"),
        });

        if (!receipt.ok) {
          // A provider cascade that exhausted itself is a real failure with a real
          // reason, not an exception the caller has to guess at.
          result.state = STATE.FAILED;
          result.error = {
            code: "no_route",
            message: receipt.error?.message || "no model produced a completion",
            failureKinds: receipt.failureKinds,
            attempts: receipt.attempts.length,
          };
          emit(EVENTS.AGENT_FAILED, { agentId: agent.id, ...result.error }, "error");
          return this.finish(result);
        }

        result.model = receipt.model;
        emit(EVENTS.AGENT_MODEL_SELECTED, {
          agentId: agent.id,
          model: receipt.model,
          tier: receipt.tier,
          iteration,
          candidates: plan.candidates,
        });
        emit(EVENTS.AGENT_OUTPUT, { agentId: agent.id, model: receipt.model, iteration });

        // The deadline is re-checked after the call, not only before it. A budget
        // enforced only between iterations is not a budget: a single call that
        // overruns still returns, and the run reports clean success having blown
        // the limit it declared. That is the orthogonal-outcomes defect in its
        // purest form -- the work was cut short and the result says otherwise.
        this.guard(agent, result, signal, startedAt);

        // The model may ask for tools. Executing them here -- rather than inside
        // the executor -- keeps one place that enforces maxToolCalls and one place
        // that can stop the loop on a denial.
        const requested = this.parseToolCalls(receipt.value);
        if (requested.length) {
          const denial = await this.runRequestedTools(requested, { agent, result, signal, startedAt, transcript, emit });
          if (denial) {
            // A denied tool is an orchestration stop, not a retryable error. The
            // model asked for something it may not have; letting it ask again is
            // how a loop turns into a harassment attempt on the permission system.
            result.state = STATE.FAILED;
            result.error = { code: "tool_denied", message: denial };
            emit(EVENTS.AGENT_PERMISSION_DENIED, { agentId: agent.id, reason: denial }, "warn");
            emit(EVENTS.AGENT_FAILED, { agentId: agent.id, ...result.error }, "error");
            return this.finish(result);
          }
          continue;
        }

        output = receipt.value;
        break;
      }

      if (output === null) {
        result.state = STATE.FAILED;
        result.error = { code: "no_output", message: "the agent produced no output" };
        emit(EVENTS.AGENT_FAILED, { agentId: agent.id, ...result.error }, "error");
        return this.finish(result);
      }

      result.output = normaliseOutput(output, agent);
      this.validateOutput(result, agent);

      this.transition(result, STATE.COMPLETED, agent);
      result.completed = true;
      emit(EVENTS.AGENT_COMPLETED, { agentId: agent.id, model: result.model, iterations: result.iterations });

      this.persist(result, agent, sessionId);
      return this.finish(result);
    } catch (err) {
      return this.failFrom(result, agent, err, emit);
    }
  }

  /**
   * Every bound check in one place, called at the top of each iteration.
   *
   * Centralised because the checks are the same on every path and the whole value
   * of having them is that they cannot be forgotten on one branch.
   */
  guard(agent, result, signal, startedAt) {
    if (signal?.aborted) {
      result.cancelled = true;
      throw new AgentCancelledError(signal.reason ? String(signal.reason) : undefined);
    }
    if (this.now() - startedAt > agent.bounds.timeoutMs) {
      result.timedOut = true;
      throw new AgentTimeoutError(agent.bounds.timeoutMs);
    }
    if (result.toolCalls > agent.bounds.maxToolCalls) {
      throw new AgentBoundError("maxToolCalls", agent.bounds.maxToolCalls, result.toolCalls);
    }
  }

  transition(result, state, agent) {
    result.state = state;
    // Recorded on the result as well as the log. The log is best-effort and can be
    // unavailable, truncated or filtered; a receipt that only lives in the log is a
    // receipt that does not exist when someone is reconstructing why a run stopped.
    result.states.push(state);
    try {
      this.log?.emit?.(EVENTS.AGENT_STATE, { agentId: agent?.id ?? null, state });
    } catch {
      // A broken logger is not a reason to fail an agent run. Everything on this
      // path already recorded the transition on the result itself.
    }
  }

  /** Validate the output against the agent's declared contract. */
  validateOutput(result, agent) {
    const contract = agent.output;
    if (!contract.fields.length) return;
    const value = result.output;
    const problems = [];

    for (const field of contract.fields) {
      const actual = value?.[field.name];
      if (actual === undefined || actual === null) {
        if (field.required) problems.push(`${field.name} is required`);
        continue;
      }
      const kind = typeof actual;
      const wanted = field.type === "array" ? "object" : field.type;
      if (field.type === "array" ? !Array.isArray(actual) : kind !== wanted) {
        problems.push(`${field.name} should be ${field.type}, got ${Array.isArray(actual) ? "array" : kind}`);
      }
      if (field.maxLength && typeof actual === "string" && actual.length > field.maxLength) {
        problems.push(`${field.name} exceeds maxLength ${field.maxLength}`);
      }
    }

    if (contract.unknownFields === "reject") {
      for (const key of Object.keys(value || {})) {
        if (!contract.fields.some((f) => f.name === key)) problems.push(`unknown field ${key}`);
      }
    }

    if (problems.length) {
      throw new RuntimeError(
        `agent ${agent.id} output did not match its declared contract: ${problems.join("; ")}`,
        "output_contract"
      );
    }
  }

  /**
   * Write the outcome back to the Blackboard and the Session.
   *
   * Best-effort by design, and the failure is recorded rather than swallowed: an
   * agent that succeeded but could not record that it succeeded has produced work
   * nobody will find again, which is the exact failure the Blackboard exists to
   * prevent. So it is surfaced on the result instead of being hidden.
   */
  persist(result, agent, sessionId) {
    const board = this.blackboard;

    // The full outcome, not just the summary text. An implementation note saying
    // "fixed the routing cascade" is close to useless a week later; the summary
    // plus the model that produced it plus the files is what makes the Blackboard
    // worth reading.
    const outcome = {
      agentId: agent.id,
      model: result.model,
      state: result.state,
      completed: result.completed,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs ?? null,
      output: result.output ?? null,
      error: result.error ?? null,
    };

    if (board && typeof board.recordImplementation === "function") {
      try {
        board.recordImplementation({
          summary: result.output?.summary || `${agent.id} completed`,
          files: result.output?.files || [],
          sessionId: sessionId || null,
        });
        // The Blackboard is keyed by project, so the Session has to be able to find
        // its way back to it. Without the reference the two stores are related only
        // by coincidence of timing.
        if (sessionId && typeof board.id === "string") result.blackboardRef = board.id;
      } catch (err) {
        result.persistError = `blackboard: ${err.message}`;
      }
    }

    const sessions = this.sessions;
    if (sessions && sessionId) {
      try {
        sessions.append(sessionId, ENTRY_KIND.AGENT, outcome, { agent: agent.id });
      } catch (err) {
        result.persistError = [result.persistError, `session: ${err.message}`].filter(Boolean).join("; ");
      }
    }
  }

  failFrom(result, agent, err, emit) {
    const code = err?.code || "agent_error";
    // The three terminal reasons stay separate. A run that timed out is not
    // "cancelled", and neither is "failed".
    if (err instanceof AgentTimeoutError) {
      result.timedOut = true;
      result.state = STATE.TIMED_OUT;
    } else if (err instanceof AgentCancelledError) {
      result.cancelled = true;
      result.state = STATE.CANCELLED;
    } else {
      result.state = STATE.FAILED;
    }
    result.error = { code, message: err?.message || String(err) };
    // Three distinct terminal events rather than one AGENT_FAILED carrying flags.
    // A single event with `timedOut: true` invites every consumer to read one field
    // and treat a timeout as a failure -- which is exactly the conflation the
    // orthogonal state on the result exists to prevent, reappearing at the event
    // layer where it is harder to notice.
    if (result.timedOut) {
      emit(EVENTS.AGENT_ERROR, { agentId: agent?.id ?? null, code, message: result.error.message, kind: "timeout" }, "error");
    } else if (result.cancelled) {
      emit(EVENTS.AGENT_CANCELLED, { agentId: agent?.id ?? null, code, message: result.error.message }, "warn");
    } else {
      emit(EVENTS.AGENT_FAILED, { agentId: agent?.id ?? null, code, message: result.error.message }, "error");
    }
    return this.finish(result);
  }

  finish(result) {
    result.finishedAt = this.now();
    result.durationMs = result.finishedAt - result.startedAt;
    return Object.freeze(result);
  }
}

/**
 * Truncate a tier list to `budget` models in preference order.
 *
 * Tiers are truncated rather than models dropped from inside a tier: the tier *is*
 * the preference signal the requirements resolver computed, so keeping tier 1 intact
 * and trimming tier 3 preserves "these are equivalent, those are worse". Dropping a
 * single model from the front of a tier would quietly change which models were
 * treated as equals.
 */
function capTiers(tiers, budget) {
  const out = [];
  let left = budget;
  for (const tier of tiers) {
    if (left <= 0) break;
    const models = tier.models.slice(0, left);
    if (models.length) out.push({ ...tier, models });
    left -= models.length;
  }
  return out;
}

/**
 * Wrap a logger so that a throwing `emit` cannot propagate.
 *
 * Every call site ends up going through this, because the ones that need it most
 * are the ones outside a try block -- the Router's route events being the clearest
 * example. A full disk or a logger bug should cost observability, not the run.
 */
function safeLog(log) {
  const wrapped = {
    errorCount: 0,
    failed: 0,
    emit(type, payload, level) {
      if (!log || typeof log.emit !== "function") return null;
      try {
        return log.emit(type, payload, level);
      } catch {
        wrapped.failed += 1;
        return null;
      }
    },
  };
  if (log && Number.isFinite(log.errorCount)) wrapped.errorCount = log.errorCount;
  return wrapped;
}

function compactTask(task) {
  if (typeof task === "string") return { title: task };
  const out = {};
  for (const k of ["id", "title", "detail"]) if (task?.[k] !== undefined) out[k] = task[k];
  return out;
}

/**
 * The system prompt: the agent's own instructions plus the assembled context.
 *
 * Instructions first, then context, so the agent's identity leads and the recorded
 * history reads as data rather than as instructions the agent might follow.
 */
export function renderSystemPrompt(agent, context) {
  return [agent.instructions, "", "--- project context ---", renderContext(context)].join("\n");
}

/**
 * The user prompt.
 *
 * Kept short on purpose. The heavy project state is already in the system prompt;
 * repeating it here spends tokens to say the same thing twice. The task is the
 * only thing that changes per call, plus the output contract, because a model that
 * does not know the shape it must answer in will not produce it.
 */
export function buildPrompt(agent, context, task, iteration = 1, transcript = []) {
  const lines = [];
  if (iteration > 1) lines.push(`(continuing, attempt ${iteration})`);
  lines.push(taskText(task, context));

  // Tool observations go after the request that produced them, in order, so the
  // model reads cause before effect.
  for (const entry of transcript || []) {
    const body = entry.output === null || entry.output === undefined ? "(no output)" : safeText(entry.output);
    lines.push(`[tool ${entry.tool}] ${body}`);
  }

  const contract = agent.output?.fields || [];
  if (contract.length) {
    lines.push("");
    lines.push(`Answer as JSON with these fields: ${contract.map((f) => f.name).join(", ")}.`);
    for (const f of contract) {
      if (f.description) lines.push(`- ${f.name} (${f.type}): ${f.description}`);
    }
  }
  return lines.join("\n");
}

function safeText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserialisable tool output]";
  }
}

function taskText(task, context) {
  if (typeof task === "string") return task;
  if (task?.title) return task.detail ? `${task.title}\n\n${task.detail}` : task.title;
  if (task?.detail) return String(task.detail);
  // No task given: the agent is working from recorded state, so point it at the
  // recorded next action rather than sending an empty prompt.
  if (context?.nextAction) {
    const note = context.nextAction.note || context.nextAction.title;
    return note ? `Continue the recorded work: ${note}` : "Continue the recorded work.";
  }
  return context?.goal ? `Work towards the recorded goal: ${context.goal}` : "Describe what you would do next.";
}

/** Coerce a completion into the shape the output contract is checked against. */
function normaliseOutput(output, agent) {
  const needsObject = agent.output.fields.length > 0;
  if (!needsObject) {
    if (typeof output === "string") return output;
    return output?.text ?? output ?? null;
  }
  const text = typeof output === "string" ? output : output?.text ?? "";
  // JSON in a code fence is the near-universal convention, and a contract check
  // that rejects it would fail every agent that behaves reasonably.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    // Do not invent a failure here. Returning the raw text lets the contract
    // validator produce the actual complaint, which is more useful than a parse
    // error the agent's contract never mentioned.
    return { text };
  }
}

export default { AgentRuntime, STATE, RuntimeError, AgentTimeoutError, AgentCancelledError, AgentBoundError, renderSystemPrompt };