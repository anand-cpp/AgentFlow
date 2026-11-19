// Multi-agent orchestration for Orchestrate Mode.
//
// Coordinates multiple agents/workers on a single task, delegating subtasks,
// aggregating results, handling conflicts, and verifying outcomes.
//
// Design:
//   - One orchestrator agent (the mode's primary agent) plans the decomposition.
//   - Each subtask is delegated to a worker agent with restricted permissions.
//   - Workers run sequentially (not in parallel) to avoid race conditions and
//     duplicated work — parallelism is not introduced for appearance.
//   - Results are aggregated into a single output with a verification status.
//   - Subagents never inherit unrestricted permissions; each gets the mode's
//     policy applied to its tool set.



/** Outcome of one delegated subtask. */
export class SubtaskResult {
  constructor({
    subtaskId = null,
    agentId = null,
    task = null,
    state = null,
    output = null,
    error = null,
    toolCalls = 0,
    iterations = 0,
    durationMs = 0,
  } = {}) {
    this.subtaskId = subtaskId;
    this.agentId = agentId;
    this.task = task;
    this.state = state;
    this.output = output;
    this.error = error;
    this.toolCalls = toolCalls;
    this.iterations = iterations;
    this.durationMs = durationMs;
  }

  get succeeded() {
    return this.state === "completed" && !!this.output;
  }

  toJSON() {
    return {
      subtaskId: this.subtaskId,
      agentId: this.agentId,
      task: this.task,
      state: this.state,
      output: this.output,
      error: this.error ? String(this.error) : null,
      toolCalls: this.toolCalls,
      iterations: this.iterations,
      durationMs: this.durationMs,
      succeeded: this.succeeded,
    };
  }
}

/** Orchestration result: aggregated subtask results + verification. */
export class OrchestrationResult {
  constructor({
    task = null,
    mode = "orchestrate",
    subtasks = [],
    state = null,
    output = null,
    error = null,
    totalToolCalls = 0,
    totalIterations = 0,
    durationMs = 0,
    conflicts = [],
    verification = null,
  } = {}) {
    this.task = task;
    this.mode = mode;
    this.subtasks = subtasks.map((s) => (s instanceof SubtaskResult ? s : new SubtaskResult(s)));
    this.state = state;
    this.output = output;
    this.error = error;
    this.totalToolCalls = totalToolCalls;
    this.totalIterations = totalIterations;
    this.durationMs = durationMs;
    this.conflicts = conflicts;
    this.verification = verification;
  }

  get succeeded() {
    return this.state === "completed" && this.subtasks.every((s) => s.succeeded);
  }

  get failedSubtasks() {
    return this.subtasks.filter((s) => !s.succeeded);
  }

  toJSON() {
    return {
      task: this.task,
      mode: this.mode,
      subtasks: this.subtasks.map((s) => s.toJSON()),
      state: this.state,
      output: this.output,
      error: this.error ? String(this.error) : null,
      totalToolCalls: this.totalToolCalls,
      totalIterations: this.totalIterations,
      durationMs: this.durationMs,
      conflicts: this.conflicts,
      verification: this.verification,
      succeeded: this.succeeded,
      failedSubtaskCount: this.failedSubtasks.length,
    };
  }
}

/**
 * ModeOrchestrator — coordinates multi-agent work within one orchestrate-mode run.
 *
 * The orchestrator does not spawn OS processes or duplicate the AgentRuntime.
 * It creates one ModeRuntime per subtask, each with a mode-filtered agent
 * registry and the same mode policy. Subtasks run sequentially.
 */
export class ModeOrchestrator {
  constructor({
    modeRuntime,
    eventLog = null,
    maxSubagents = 3,
    approver = null,
  } = {}) {
    if (!modeRuntime) throw new Error("ModeOrchestrator requires a modeRuntime");
    this.modeRuntime = modeRuntime;
    this.eventLog = eventLog || null;
    this.maxSubagents = maxSubagents;
    this.approver = approver || null;
  }

  /**
   * Decompose a task into subtasks using the planner agent, then execute each
   * subtask with an appropriate worker agent.
   *
   * Returns an OrchestrationResult with aggregated results.
   */
  async orchestrate({ task, sessionId = null, agentId = "planner", modePolicy = null } = {}) {
    const startedAt = Date.now();
    const policy = modePolicy || this.modeRuntime.policy;

    if (!policy.canSubagent) {
      return new OrchestrationResult({
        task,
        mode: this.modeRuntime.mode,
        state: "failed",
        error: new Error(`${this.modeRuntime.mode} mode does not permit subagent delegation`),
        durationMs: Date.now() - startedAt,
      });
    }

    this._emit("orchestrate.start", { task, mode: this.modeRuntime.mode, maxSubagents: this.maxSubagents });

    // Step 1: Decompose the task into subtasks using the planner.
    const decomposition = await this._decompose({ task, agentId, sessionId });
    if (!decomposition.ok) {
      return new OrchestrationResult({
        task,
        mode: this.modeRuntime.mode,
        state: "failed",
        error: decomposition.error,
        durationMs: Date.now() - startedAt,
      });
    }

    const subtasks = decomposition.subtasks || [];
    if (!subtasks.length) {
      return new OrchestrationResult({
        task,
        mode: this.modeRuntime.mode,
        state: "completed",
        output: { summary: "No subtasks identified; task may be trivially completable", subtasks: [] },
        durationMs: Date.now() - startedAt,
      });
    }

    // Step 2: Execute each subtask sequentially with a worker agent.
    const results = [];
    const conflicts = [];

    for (let i = 0; i < subtasks.length && i < this.maxSubagents; i += 1) {
      const subtask = subtasks[i];
      const workerAgent = this._selectWorkerAgent(subtask, policy);

      this._emit("orchestrate.subtask_start", {
        subtaskId: subtask.id || `subtask-${i}`,
        agentId: workerAgent,
        task: subtask.title || subtask,
      });

      const result = await this.modeRuntime.run({
        agentId: workerAgent,
        task: typeof subtask === "string" ? subtask : (subtask.title || String(subtask)),
        sessionId,
        extra: { _orchestration: true, _subtaskIndex: i, _mode: this.modeRuntime.mode },
      });

      const subtaskResult = new SubtaskResult({
        subtaskId: subtask.id || `subtask-${i}`,
        agentId: workerAgent,
        task: typeof subtask === "string" ? subtask : (subtask.title || String(subtask)),
        state: result.state,
        output: result.output,
        error: result.error,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
        durationMs: result.durationMs || 0,
      });

      results.push(subtaskResult);

      if (subtaskResult.state === "failed") {
        conflicts.push({
          subtaskId: subtaskResult.subtaskId,
          reason: subtaskResult.error ? String(subtaskResult.error.message) : "subtask failed",
        });
      }

      this._emit("orchestrate.subtask_complete", {
        subtaskId: subtaskResult.subtaskId,
        state: subtaskResult.state,
        succeeded: subtaskResult.succeeded,
      });
    }

    // Step 3: Aggregate results.
    const allSucceeded = results.every((r) => r.succeeded);
    const state = allSucceeded ? "completed" : "failed";

    const output = {
      summary: `Orchestrated ${results.length} subtask(s): ${results.filter((r) => r.succeeded).length} succeeded, ${results.filter((r) => !r.succeeded).length} failed`,
      subtasks: results.map((r) => ({
        id: r.subtaskId,
        agent: r.agentId,
        state: r.state,
        summary: r.output?.summary || null,
      })),
      conflicts: conflicts.length ? conflicts : null,
    };

    const verification = {
      verified: allSucceeded,
      checked: results.length,
      passed: results.filter((r) => r.succeeded).length,
      failed: results.filter((r) => !r.succeeded).length,
    };

    const totalDuration = Date.now() - startedAt;

    this._emit("orchestrate.complete", {
      task,
      state,
      subtaskCount: results.length,
      succeeded: results.filter((r) => r.succeeded).length,
      failed: results.filter((r) => !r.succeeded).length,
      durationMs: totalDuration,
    });

    return new OrchestrationResult({
      task,
      mode: this.modeRuntime.mode,
      subtasks: results,
      state,
      output,
      error: allSucceeded ? null : new Error(`${results.filter((r) => !r.succeeded).length} subtask(s) failed`),
      totalToolCalls: results.reduce((sum, r) => sum + r.toolCalls, 0),
      totalIterations: results.reduce((sum, r) => sum + r.iterations, 0),
      durationMs: totalDuration,
      conflicts,
      verification,
    });
  }

  /** Decompose a task into subtasks using the planner agent. */
  async _decompose({ task, agentId, sessionId }) {
    try {
      const result = await this.modeRuntime.run({
        agentId: agentId || "planner",
        task: `Decompose the following objective into ordered, checkable subtasks. For each subtask, provide a title and a one-line description of what changes and how success is checked. Objective: ${task}`,
        sessionId,
        extra: { _orchestration: true, _phase: "decomposition" },
      });

      if (result.state !== "completed" || !result.output) {
        return { ok: false, error: new Error("decomposition did not complete") };
      }

      const output = result.output;
      const subtasks = Array.isArray(output.steps) ? output.steps : [];
      const normalized = subtasks.map((s, i) => ({
        id: s.id || `subtask-${i}`,
        title: s.title || String(s),
        description: s.description || null,
      }));

      return { ok: true, subtasks: normalized };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  /** Select the best worker agent for a subtask based on its content. */
  _selectWorkerAgent(subtask, policy) {
    const title = (typeof subtask === "string" ? subtask : (subtask.title || "")).toLowerCase();
    const desc = (typeof subtask === "string" ? "" : (subtask.description || "")).toLowerCase();
    const text = `${title} ${desc}`;

    // Heuristic agent selection based on subtask content.
    if (/test|verify|assert|spec|coverage/.test(text)) {
      if (policy.allowedAgentIds.includes("tester")) return "tester";
    }
    if (/debug|fail|error|bug|fix|repro|reproduce/.test(text)) {
      if (policy.allowedAgentIds.includes("debugger")) return "debugger";
    }
    if (/review|audit|check|inspect|find|vuln/.test(text)) {
      if (policy.allowedAgentIds.includes("reviewer")) return "reviewer";
    }
    if (/plan|decompos|architect|design|structure/.test(text)) {
      if (policy.allowedAgentIds.includes("planner")) return "planner";
    }
    // Default to coder for implementation subtasks.
    if (policy.allowedAgentIds.includes("coder")) return "coder";
    // Fall back to the first allowed agent.
    return policy.allowedAgentIds[0] || "coder";
  }

  /** Emit an orchestration event. */
  _emit(type, data) {
    if (this.eventLog) {
      this.eventLog.emit(type, data, "info");
    }
  }
}

export default { ModeOrchestrator, SubtaskResult, OrchestrationResult };
