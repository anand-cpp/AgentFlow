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
import { redactDeep } from "../redact.js";
import { ENTRY_KIND } from "../sessions.js";
import { SEVERITY, FINDING_SOURCE } from "../blackboard.js";
import { resolveModelPlan, explainPlan } from "./requirements.js";
import { buildAgentContext, renderContext, ContextError } from "./context.js";
import { runTool, OUTCOME } from "./tools.js";
import { AgentError, AgentNotFoundError } from "./registry.js";
import { WorkspaceRoot } from "./workspace.js";

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
    // A resolved WorkspaceRoot, or a plain string. Resolved once, here, and frozen:
    // every tool call in this run compares against this value, so it cannot be
    // recomputed per call without the answer depending on when the call happened.
    workspaceRoot = null,
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
    this.workspace = this.#bindWorkspace(workspaceRoot);
    // Blackboard dedupe keys for the CURRENT run. Seeded here and cleared at the top
    // of every run(), so its lifetime is exactly one run -- see #board.
    this.#boardOnceKeys = new Set();
    // Wrapped once, here, and the wrapper is what everything downstream uses --
    // including the Router, which emits route events outside its own try/catch.
    // Logging is observability; a broken logger must not decide whether an agent
    // run succeeds.
    this.log = safeLog(log);
  }

  /**
   * Accept a WorkspaceRoot, a string, or nothing -- and refuse to guess.
   *
   * A run with real tools but no root would fail every call deep inside a tool with
   * "no workspace root was configured", which reads like a tool bug. Failing here
   * instead names the actual mistake, once, before a provider is dispatched.
   *
   * A string is wrapped, not trusted. Wrapping re-validates it and freezes the
   * result, so a caller who passes `process.cwd()` gets the same immutability as
   * one who passed a resolved holder.
   */
  // Blackboard record keys written during the current run. Not a static field and
  // not keyed by board: the dedupe is meant to collapse retries *within* one run, so
  // its lifetime has to be one run.
  #boardOnceKeys = new Set();

  #bindWorkspace(workspaceRoot) {
    if (workspaceRoot == null) return null;
    if (workspaceRoot instanceof WorkspaceRoot) return workspaceRoot;
    if (typeof workspaceRoot === "string") return new WorkspaceRoot({ explicit: workspaceRoot });
    throw new RuntimeError(
      "workspaceRoot must be a WorkspaceRoot, a string path, or null",
      "bad_workspace_root",
    );
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
  async runRequestedTools(calls, { agent, result, signal, startedAt, transcript, emit, sessionId = null }) {
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

      // The workspace is the run's, not the call's. It is passed in the context
      // rather than read from the arguments, because an argument the model chose is
      // not something containment can be based on -- the whole point is that the
      // model does not get to say where the walls are.
      const toolCtx = this.workspace
        ? { workspaceRoot: this.workspace.root }
        : // No root and the tool needs one: refuse here, with the tool named. The
          // alternative is letting it fail inside the body with a message about
          // configuration, which points the reader at the wrong file.
          requiresRoot(call.tool)
          ? null
          : {};

      if (toolCtx === null) {
        const outcome = Object.freeze({
          outcome: OUTCOME.ERROR,
          tool: call.tool,
          scope: tool.scope,
          output: null,
          contexts: [],
          approved: false,
          attempt: null,
          error: {
            code: "no_workspace_root",
            message: `${call.tool} needs a workspace root, and this run has none`,
            step: "workspace",
          },
        });
        const callStartedAt = this.now();
        result.toolResults.push(outcome);
        result.toolExecutions.push(
          summariseToolExecution(outcome, { agent, tool, startedAt: callStartedAt, now: this.now }),
        );
        emit(EVENTS.AGENT_TOOL_FAILED, {
          agentId: agent.id,
          tool: call.tool,
          scope: tool.scope,
          code: outcome.error.code,
          message: outcome.error.message,
        }, "error");
        return outcome.error.message;
      }

      const callStartedAt = this.now();
      const outcome = await runTool(agent, tool, call, {
        preExecute: agent.lifecycle?.prepare ? [agent.lifecycle.prepare] : [],
        guards: this.guards,
        approver: this.approver,
        log: this.log,
        signal,
        now: this.now,
        // Observation of the permission verdict, not a second opinion on it. runTool
        // is still the only thing that decides, and the events land in the order
        // things actually happened: requested, approved or denied, started,
        // completed.
        onDecision: (info) => {
          if (info.granted === true) {
            emit(EVENTS.AGENT_TOOL_APPROVED, {
              agentId: agent.id,
              tool: info.tool,
              scope: info.scope,
              decision: info.decision,
              args: redactArgs(info.args),
            });
          } else if (info.granted === false) {
            emit(EVENTS.AGENT_PERMISSION_DENIED, {
              agentId: agent.id,
              tool: info.tool,
              scope: info.scope,
              decision: info.decision,
              reason: info.reason ?? null,
            }, "warn");
          }
        },
        // `started` means the tool body is about to run, which is the only honest
        // meaning of the word. Emitting it before asking for permission would report
        // a call as underway that is about to be refused, and the resulting log would
        // claim work happened that never did.
        //
        // `info` is the post-transform call, so its tool/scope are what actually run.
        // Reporting the pre-transform request here would let the log and the
        // permission decision disagree about which call started.
        onDispatch: (info) => {
          emit(EVENTS.AGENT_TOOL_STARTED, {
            agentId: agent.id,
            tool: info?.tool ?? call.tool,
            scope: info?.scope ?? tool.scope,
            // The workspace the call is confined to, so a log reader can tell which
            // tree was in bounds without reconstructing it from the run's arguments.
            workspaceRoot: this.workspace?.root ?? null,
          });
        },
        ...toolCtx,
      });

      result.toolResults.push(outcome);
      const summary = summariseToolExecution(outcome, { agent, tool, startedAt: callStartedAt, now: this.now });
      result.toolExecutions.push(summary);

      // Terminal events are chosen from the outcome, not from whether a result
      // object came back. AGENT_TOOL_COMPLETED is emitted for every call the
      // pipeline finished, so a consumer that reads only "completed" would record a
      // refusal as a success -- the exact defect the separate event types exist to
      // prevent. It carries `outcome` rather than being mutually exclusive with
      // failed/cancelled precisely because both happened.
      emit(EVENTS.AGENT_TOOL_COMPLETED, {
        agentId: agent.id,
        tool: call.tool,
        outcome: outcome.outcome,
        approved: outcome.approved,
        durationMs: summary.durationMs,
      });

      if (outcome.outcome === OUTCOME.DENIED) {
        this.#recordDenial(this.blackboard, sessionId, { agent, call, outcome });
        emit(EVENTS.AGENT_TOOL_FAILED, {
          agentId: agent.id,
          tool: call.tool,
          scope: tool.scope,
          code: outcome.error?.code ?? "permission_denied",
          message: outcome.error?.message ?? null,
          denied: true,
        }, "warn");
        return outcome.error?.message || `tool ${call.tool} was denied`;
      }

      if (outcome.outcome === OUTCOME.ERROR) {
        const cancelled = isCancellation(outcome);
        const event = cancelled ? EVENTS.AGENT_TOOL_CANCELLED : EVENTS.AGENT_TOOL_FAILED;
        this.#recordToolFailure(this.blackboard, sessionId, { agent, call, outcome });
        emit(event, {
          agentId: agent.id,
          tool: call.tool,
          scope: tool.scope,
          code: outcome.error?.code ?? "tool_error",
          message: outcome.error?.message ?? null,
          durationMs: summary.durationMs,
        }, cancelled ? "warn" : "error");
        // A failed tool is not fatal by itself. The model gets the error as
        // context and may narrow the request, which is the behaviour that makes an
        // agent useful rather than merely supervised. Only a refusal stops the
        // loop, because retrying a denied call is asking for the same permission
        // again.
        if (cancelled) return outcome.error?.message || `tool ${call.tool} was cancelled`;
      }

      agent.lifecycle?.onToolResult?.(outcome, { agent, result });
      if (outcome.outcome === OUTCOME.OK) {
        transcript.push({ role: "tool", tool: call.tool, output: outcome.output, contexts: outcome.contexts });
      } else {
        // An error still goes into the transcript, as an observation. Hiding it
        // leaves the model with a tool call it made and no trace of the answer,
        // which it will either retry blindly or treat as succeeded.
        transcript.push({
          role: "tool",
          tool: call.tool,
          output: null,
          error: outcome.error ?? null,
          contexts: outcome.contexts,
        });
      }
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
    // Fresh dedupe scope per run. A runtime can be reused, and a set carried over
    // from the previous run would make this run's first blocker silently vanish.
    this.#boardOnceKeys = new Set();
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
      // The bounded record of each call, as opposed to toolResults which holds the
      // full outputs. Two views of the same thing on purpose: one is what the model
      // saw and must not be truncated further, the other is what gets persisted.
      toolExecutions: [],
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
          // Not a bare finish(). This is the single most common way a real run dies --
          // every provider refused or failed -- so returning without persisting would
          // mean the most frequent failure is the one that leaves no trace at all.
          return this.endFailed(result, agent, sessionId);
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
          const denial = await this.runRequestedTools(requested, {
            agent,
            result,
            signal,
            startedAt,
            transcript,
            emit,
            sessionId,
          });
          if (denial) {
            // A denied tool is an orchestration stop, not a retryable error. The
            // model asked for something it may not have; letting it ask again is
            // how a loop turns into a harassment attempt on the permission system.
            result.state = STATE.FAILED;
            result.error = { code: "tool_denied", message: denial };
            // No AGENT_PERMISSION_DENIED here: runRequestedTools already emitted it
            // with the tool, scope and reason. Emitting the same event type twice for
            // one refusal gives a consumer two records and no way to tell that they
            // are the same refusal.
            emit(EVENTS.AGENT_FAILED, { agentId: agent.id, ...result.error }, "error");
            return this.endFailed(result, agent, sessionId);
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
        return this.endFailed(result, agent, sessionId);
      }

      result.output = normaliseOutput(output, agent);
      this.validateOutput(result, agent);

      this.transition(result, STATE.COMPLETED, agent);
      result.completed = true;
      emit(EVENTS.AGENT_COMPLETED, { agentId: agent.id, model: result.model, iterations: result.iterations });

      this.stamp(result);
      this.persist(result, agent, sessionId);
      return this.finish(result);
    } catch (err) {
      return this.failFrom(result, agent, err, emit, sessionId);
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
    // Null when the run failed before an agent was resolved -- "that agent does not
    // exist" is a result, not a throw, so this method can be reached with nothing
    // resolved. Falling back to the id the run was asked for keeps the record
    // attributable instead of throwing on the way out of an error path.
    const agentId = agent?.id ?? result.agentId ?? null;
    const label = agentId || "unknown agent";

    // The full outcome, not just the summary text. An implementation note saying
    // "fixed the routing cascade" is close to useless a week later; the summary
    // plus the model that produced it plus the files is what makes the Blackboard
    // worth reading.
    const outcome = {
      agentId,
      model: result.model,
      state: result.state,
      completed: result.completed,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs ?? null,
      output: result.output ?? null,
      error: result.error ?? null,
      // Where the tools were allowed to reach. Without this a session says an agent
      // read a file but not which tree that file was in, which is the one fact a
      // later reader needs to judge whether the run stayed in bounds.
      workspaceRoot: this.workspace?.root ?? null,
      // The bounded per-call records, never the outputs themselves. A session file
      // that accumulated raw tool output would grow with the task and stop being
      // readable; this keeps the facts and drops the payloads.
      toolExecutions: result.toolExecutions ?? [],
    };

    if (board && typeof board.recordImplementation === "function") {
      try {
        // Only a successful run is an implementation. Recording "author completed"
        // for a run that was refused at its first tool call would put a false claim
        // at the top of the project's history; the failure itself has already been
        // written as a blocker or a finding.
        if (result.completed) {
          board.recordImplementation({
            summary: result.output?.summary || `${label} completed`,
            files: result.output?.files || [],
            sessionId: sessionId || null,
          });
        }
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
        sessions.append(sessionId, ENTRY_KIND.AGENT, outcome, { agent: agentId });

        // Each tool call gets its own entry as well as riding along on the agent
        // entry. One session entry per call is what lets `aflow sessions` show what
        // an agent actually did rather than only what it concluded -- and it means a
        // run that dies mid-flight still leaves the calls it had already made,
        // which is exactly the run you want to be able to audit.
        //
        // ENTRY_KIND.TOOL_RESULT rather than TOOL_CALL: the record carries the
        // outcome, not just the request. SessionStore re-verifies every entry for
        // credentials on the way in, so a record cannot become a place a key is
        // kept.
        const executions = Array.isArray(result.toolExecutions) ? result.toolExecutions : [];
        for (const record of executions) {
          sessions.append(sessionId, ENTRY_KIND.TOOL_RESULT, record, { agent: agentId });
        }
      } catch (err) {
        result.persistError = [result.persistError, `session: ${err.message}`].filter(Boolean).join("; ");
      }
    }
  }

  /**
   * End a run that did not succeed.
   *
   * Every failure path funnels through here, which is the only way to guarantee that
   * a run which died still left a trace. The alternative -- persisting only on
   * success -- produces a session that looks clean precisely when something went
   * wrong, and a failure nobody can find is the most expensive kind.
   */
  endFailed(result, agent, sessionId, err = null) {
    this.#recordRunFailure(this.blackboard, sessionId, { agent, result, err });
    // Stamped before the write, for the same reason as the completed path: a failed
    // run is exactly the one whose duration an operator wants to read back.
    this.stamp(result);
    this.persist(result, agent, sessionId);
    return this.finish(result);
  }

  failFrom(result, agent, err, emit, sessionId = null) {
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
    return this.endFailed(result, agent, sessionId, err);
  }

/**
   * Write one Blackboard transition.
   *
   * Two rules keep this from becoming a transcript in a different format. First,
   * `onceKey`: a run that retries the same refused call ten times has one blocker,
   * not ten. Second, the vocabulary is the task-level one -- a permission wall, an
   * infrastructure failure, an implementation -- and never a per-call narration. The
   * call-by-call detail belongs to Sessions, which is where it can be exhaustive
   * without being unreadable.
   *
   * Returns the created record, or null when it was suppressed or failed. Failures
   * are swallowed by design: the Blackboard is a record of the work, and losing it
   * must not change the run's outcome.
   */
  #board(board, sessionId, method, payload, onceKey = null) {
    if (!board || typeof board[method] !== "function") return null;
    let seen = null;
    if (onceKey) {
      // Per RUN, not per board and not for the lifetime of the runtime. The set is
      // reset at the top of run() precisely so that a reused runtime still reports a
      // blocker on its second run: a module-level WeakMap keyed by board suppressed
      // it forever, leaving a board whose blocker described a wall the current run
      // never hit while hiding the one it did.
      seen = this.#boardOnceKeys;
      if (seen.has(onceKey)) return null;
      seen.add(onceKey);
    }
    try {
      return board[method]({ ...payload, sessionId: sessionId ?? null });
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  }

  /** A refused call is a wall the run hit, which is a blocker in task terms. */
  #recordDenial(board, sessionId, { agent, call, outcome }) {
    if (!board) return;
    return this.#board(
      board,
      sessionId,
      "recordBlocker",
      {
        title: `${agent.id} was refused ${call.tool}`,
        detail: [
          `reason: ${outcome.error?.message ?? "denied"}`,
          `scope: ${outcome.scope ?? "unknown"}`,
          `workspace: ${this.workspace?.root ?? "unset"}`,
        ].join("\n"),
        severity: SEVERITY.HIGH,
        raisedBy: agent.id,
      },
      `denied:${call.tool}:${outcome.scope ?? ""}`,
    );
  }

  /**
   * A tool that failed for a reason other than permission.
   *
   * Recorded as a finding rather than a bug: a tool crashing on a malformed path is
   * not yet evidence of a defect in the tool. Calling it a bug here would make the
   * bug list report rate of model mistakes.
   */
  #recordToolFailure(board, sessionId, { agent, call, outcome }) {
    if (!board) return;
    const cancelled = isCancellation(outcome);
    if (cancelled) {
      return this.#board(
        board,
        sessionId,
        "recordBlocker",
        {
          title: `${agent.id} was cut short during ${call.tool}`,
          detail: `reason: ${outcome.error?.message ?? "cancelled"}`,
          severity: SEVERITY.MEDIUM,
          raisedBy: agent.id,
        },
        `cancelled:${call.tool}`,
      );
    }
    return this.#board(
      board,
      sessionId,
      "recordFinding",
      {
        title: `${call.tool} failed during ${agent.id}`,
        detail: outcome.error?.message ?? null,
        severity: SEVERITY.LOW,
        source: FINDING_SOURCE.AGENT,
        author: agent.id,
      },
      `failed:${call.tool}:${outcome.error?.code ?? "unknown"}`,
    );
  }

  /**
   * A run that ended in failure.
   *
   * `bug` is reserved for the codes that mean *this system* is wrong rather than
   * that the work went badly: an unhandled shape, a missing capability, an internal
   * throw. A provider being down or a model producing unusable output is recorded as
   * a finding or a blocker, because putting "the network fell over" in the bug list
   * trains everyone to ignore the bug list.
   */
  #recordRunFailure(board, sessionId, { agent, result, err }) {
    if (!board) return;
    const code = result.error?.code ?? err?.code ?? "unknown";
    // Same null-agent case as persist(): an unresolved agent is a legitimate
    // terminal state, and a recording helper is the last place that should be the
    // thing that throws.
    const label = agent?.id ?? result.agentId ?? "unknown agent";
    const by = agent?.id ?? null;
    if (INTERNAL_DEFECT_CODES.has(code)) {
      return this.#board(
        board,
        sessionId,
        "recordBug",
        {
          title: `${label} failed with an internal error: ${code}`,
          detail: [result.error?.message ?? err?.message ?? null, `state: ${result.state}`]
            .filter(Boolean)
            .join("\n"),
          severity: SEVERITY.HIGH,
          discoveredBy: by,
        },
        `bug:${code}`,
      );
    }
    return this.#board(
      board,
      sessionId,
      "recordBlocker",
      {
        title: `${label} stopped: ${code}`,
        detail: [result.error?.message ?? err?.message ?? null, `state: ${result.state}`]
          .filter(Boolean)
          .join("\n"),
        severity: result.timedOut || result.cancelled ? SEVERITY.MEDIUM : SEVERITY.HIGH,
        raisedBy: by,
      },
      `failed-run:${code}`,
    );
  }

  /**
   * Stamp the run's wall-clock duration.
   *
   * Separate from finish() because the session write needs the duration and happens
   * BEFORE finish() runs. Sharing one method is what keeps the two in agreement:
   * when stamping was left to finish() alone, every persisted entry recorded
   * `durationMs: null` -- a field that looked populated and never was, so the one
   * number that says whether a slow run was slow could not be read back.
   */
  stamp(result) {
    result.finishedAt = this.now();
    result.durationMs = result.finishedAt - result.startedAt;
    return result;
  }

  finish(result) {
    this.stamp(result);
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
 * Codes that mean this system is broken, as opposed to the work going badly.
 *
 * The distinction decides which Blackboard list an item lands in, and the value of
 * the split is entirely in the second list: a bug list that also contains "the
 * provider was down" is a list nobody reads.
 */
const INTERNAL_DEFECT_CODES = new Set([
  "unexpected_error",
  "bad_verdict",
  "bad_workspace_root",
  "bad_sessions",
  "output_invalid",
  "no_output",
]);

/**
 * Tools that cannot run without a workspace root.
 *
 * Declared here rather than inferred from the body, because inference would mean
 * either calling each tool with a null root and catching whatever it throws, or
 * trusting a property a tool body sets about itself. An explicit list can be read,
 * checked against the real tool set, and fails loudly when the two drift.
 */
const ROOT_REQUIRING_TOOLS = new Set([
  "filesystem.read",
  "filesystem.write",
  "filesystem.search",
  "shell.execute",
]);

function requiresRoot(toolName) {
  return ROOT_REQUIRING_TOOLS.has(toolName);
}

/** Was this failure a cancellation rather than an ordinary error? */
function isCancellation(outcome) {
  const code = outcome?.error?.code;
  return code === "cancelled" || code === "aborted" || code === "agent_cancelled";
}

/**
 * Cap on any single string kept in a tool record.
 *
 * These records go to a session file that is read back and displayed, so an
 * unbounded field is an unbounded file. 300 characters holds a path, an error
 * message or an exit code with room to spare, and is long enough to be evidence
 * rather than a stub.
 */
const MAX_RECORD_TEXT = 300;

function clampText(value, max = MAX_RECORD_TEXT) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Arguments as they appear in an event, reduced to what a reader needs.
 *
 * A shell command's arguments are its meaning -- recording the command without
 * them would leave the receipt unable to answer "what actually ran" -- but a
 * content argument can be an entire file, so values are clamped and the total is
 * bounded by a count as well as a length.
 *
 * Clamped *and* credential-redacted, in that order. Clamping first bounds the work
 * the redactor has to do; redaction second, because this is reached from the
 * permission observer, which fires BEFORE runTool's credential gate. A call whose
 * arguments carry a credential is refused a moment later -- but the approval event
 * is written first, so an event log that recorded raw arguments would persist the
 * very secret the gate exists to keep out. SessionStore.append re-verifies entries
 * on the write path; the event log has no such gate, so it cannot rely on one.
 */
function redactArgs(args, { maxKeys = 12, maxValue = 200 } = {}) {
  if (!args || typeof args !== "object") return null;
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(args)) {
    if (keys >= maxKeys) {
      out["..."] = `${Object.keys(args).length - keys} more argument(s)`;
      break;
    }
    keys += 1;
    if (value == null || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      // argv is the point of a shell record, so arrays keep their shape and are
      // clamped per element.
      out[key] = value.slice(0, maxKeys).map((v) => clampText(v, maxValue));
    } else {
      out[key] = clampText(value, maxValue);
    }
  }
  // Redaction last, over the already-clamped copy. `redactDeep` never throws, so a
  // redaction failure can never take down the run that is being audited.
  return redactDeep(out);
}

/**
 * Reduce a tool result to the record worth keeping.
 *
 * This is the shape that reaches a session file and an event stream, and it is
 * deliberately not the result. A filesystem.read of a 256KB file produces a result
 * that would multiply across every call of a long session; what makes the run
 * reconstructable afterwards is the facts -- which tool, under which permission
 * decision, for how long, how big the answer was, how much of it was dropped, and
 * what went wrong.
 *
 * Truncation metadata is carried explicitly rather than left to the caller to
 * infer, because "the model saw a prefix" is the most consequential thing about a
 * bounded result and it has to survive being written to disk.
 */
function summariseToolExecution(outcome, { agent, tool, startedAt, now = () => Date.now() }) {
  const output = outcome?.output ?? null;
  const isObj = output && typeof output === "object" && !Array.isArray(output);
  return {
    tool: outcome?.tool ?? null,
    scope: outcome?.scope ?? tool?.scope ?? null,
    agent: agent?.id ?? null,
    status: outcome?.outcome ?? null,
    approved: Boolean(outcome?.approved),
    durationMs: Math.max(0, now() - (startedAt ?? now())),
    permission: outcome?.outcome === OUTCOME.DENIED ? "denied" : outcome?.approved ? "approved" : "allowed",
    errorCode: outcome?.error?.code ?? null,
    errorMessage: clampText(outcome?.error?.message ?? null),
    truncated: isObj
      ? {
          output: Boolean(output.truncated ?? output.stdoutTruncated ?? output.stderrTruncated),
          originalSize: output.originalSize ?? output.stdoutBytes ?? output.returnedSize ?? null,
          returnedSize: output.returnedSize ?? null,
          limit: output.limit ?? null,
        }
      : null,
    // A one-line description, never the payload.
    summary: isObj ? clampText(toolSummary(output)) : clampText(output),
  };
}

/** The most informative single line a result can offer, per tool shape. */
function toolSummary(output) {
  if (typeof output === "string") return output;
  if (output.path != null && output.bytes != null) return `${output.path} (${output.bytes} bytes written)`;
  if (output.path != null && output.size != null) return `${output.path} (${output.size} bytes)`;
  if (output.matchCount != null) return `${output.matchCount} match(es) for ${JSON.stringify(output.pattern ?? "")}`;
  if (output.exitCode !== undefined && output.exitCode !== null) {
    const cut = output.stdoutTruncated || output.stderrTruncated ? ", output truncated" : "";
    return `${output.command} exited ${output.exitCode}${cut}`;
  }
  return null;
}


  /**
   * Wrap a logger so that a throwing `emit` cannot propagate.
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
    lines.push(`[tool ${entry.tool}] ${renderObservation(entry)}`);
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

/**
 * One tool observation, as the model sees it.
 *
 * A failure is rendered as its error, never as "(no output)". That distinction is
 * load-bearing: a model handed a tool call and "(no output)" cannot tell a tool that
 * returned nothing from one that was refused, crashed or ran out of time, so it will
 * either retry blindly or -- worse -- treat the call as having succeeded and build on
 * a result that does not exist. The error text is also the only thing that lets a
 * model *adapt* -- "path resolves outside the workspace" tells it to try a different
 * path, where a bare absence tells it nothing.
 */
function renderObservation(entry) {
  if (entry.error) {
    const code = entry.error.code ? ` (${entry.error.code})` : "";
    return `error${code}: ${entry.error.message ?? "the tool failed for an unspecified reason"}`;
  }
  if (entry.output === null || entry.output === undefined) return "(no output)";
  return safeText(entry.output);
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
