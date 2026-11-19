// Original AgentFlow terminal — unified coding-agent TUI.
//
import readline from "node:readline";
import { bold, dim, green, red, yellow, width, truncate, head, interpretChoice, terminalWidth, cyan } from "../cli/ui.js";
import { AgentRuntime } from "../core/agents/runtime.js";
import { AgentRegistry } from "../core/agents/registry.js";
import { builtinSpecs } from "../core/agents/definitions.js";
import { createRealTools } from "../core/agents/real-tools.js";
import { complete, listModels } from "../core/gateway.js";
import { ProviderHealth } from "../core/provider-health.js";
import { RollingWindowLimiter, rateLimitsFromRegistry } from "../core/rate-limit.js";
import { UsageLedger } from "../core/usage-ledger.js";
import { SessionStore, defaultSessionsDir } from "../core/sessions.js";
import { BlackboardStore, defaultBlackboardDir } from "../core/blackboard.js";
import { resolveWorkspaceRoot } from "../core/agents/workspace.js";
import { PROVIDERS } from "../core/gateway-server.js";
import { selectFromList } from "../tui/interact.js";
import { PIPELINE_ROUNDS, runFullTribunal } from "../core/tribunal/stage-oracle.js";
import { STAGE_OUTCOME } from "../core/tribunal/stage.js";
import { buildModelItems, createModelDialogSpec } from "../tui/model-picker.js";
import { buildAgentContext } from "../core/agents/context.js";

const COLUMNS = terminalWidth();

// ---- Runtime construction helpers ----

function makeApprover(flags) {
  if (flags.yes === true || flags.yes === "true") return async () => true;
  if (flags.deny === true || flags.deny === "true") return async () => false;

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return async () => {
      process.stderr.write(
        "\napproval needed, but this is not a terminal.\n" +
          "Re-run with --yes to approve every gated action, or --deny to refuse them.\n",
      );
      return false;
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return async (call) => {
    if (call?.continuation) {
      const tool = call.tool || "a tool";
      const answer = (
        await rl.question(
          `\nA tool call may not have completed before the provider failed.\n` +
            `The tool was: ${tool}\n` +
            `Should I retry it on the new provider? [y/N] `,
        )
      )
        .trim()
        .toLowerCase();
      return answer === "y" || answer === "yes";
    }
    const answer = (await rl.question(`  allow ${call.tool} ${truncate(JSON.stringify(call.args), 90)}? [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

function initialState() {
  return {
    now: new Date().toLocaleTimeString(),
    gateway: { reachable: false, latency: null },
    version: "1.0.0",
    catalogueCount: 0,
    reachableProbeCount: 0,
    recent: [],
    probes: [],
    error: "",
  };
}

function resultState(result) {
  const facts = [];
  if (result.completed) facts.push(green("completed"));
  if (result.timedOut) facts.push(yellow("timed out"));
  if (result.cancelled) facts.push(yellow("cancelled"));
  if (!result.completed && !result.timedOut && !result.cancelled) facts.push(red("failed"));

  return {
    now: new Date().toLocaleTimeString(),
    outcome: facts.join(dim(", ")),
    iterations: result.iterations || 0,
    toolCalls: result.toolCalls || 0,
    model: result.model ?? "no model",
    error: result.error ? `${result.error.code}: ${result.error.message}` : null,
    workspace: result.workspace ? `${result.workspace.root} (${result.workspace.source})` : "—",
    sessionId: result.sessionId || null,
    persistError: result.persistError || null,
    output: result.output,
    states: result.states || [],
    plan: result.plan,
  };
}

// ---- Renderers ----

function _renderHeader(flags) {
  const items = [
    { label: "agentflow", value: bold("AgentFlow") },
    { label: "model", value: cyan(flags.model || "—") },
    { label: "provider", value: flags.gatewayReachable ? green("up") : red("down") },
  ];
  const cols = Math.floor((COLUMNS - 3) / 3);
  let line = "";
  for (const s of items) {
    const body = `${s.label.padEnd(8)}${s.value}`;
    line += body + " ".repeat(Math.max(1, cols - width(body))) + "  ";
  }
  return bold("AgentFlow") + dim("  terminal coder ") + line.trim();
}

function renderFooter(_flags) {
  const keys = "[Esc] cancel  [F2] palette  [Enter] submit  [Tab] toggle pane";
  return dim(keys);
}

function renderProgress(result) {
  const lines = [];
  lines.push(bold("AgentFlow — agent run"));
  lines.push("");
  lines.push(`  outcome: ${result.outcome}`);
  lines.push(
    `  iterations: ${result.iterations} / ${result.iterations ? green(`≤${12}`) : "(capped at 12)"}`,
  );
  lines.push(`  tool calls: ${result.toolCalls}`);
  lines.push(`  model: ${result.model}`);
  if (result.error) lines.push(`  error: ${red(result.error)}`);
  if (result.persistError) lines.push(`  persist: ${yellow(result.persistError)}`);
  lines.push(`  workspace: ${result.workspace}`);
  if (result.sessionId) lines.push(`  session: ${dim(result.sessionId)}`);
  lines.push("");
  lines.push(
    result.output
      ? `  output: ${String(result.output.summary || "").slice(0, 60)}${String(result.output.summary || "").length > 60 ? "…" : ""}`
      : "  (no output yet)",
  );
  lines.push("");
  lines.push(
    bold("Agent states:") + ` ${result.states.map((s) => s.toLowerCase()).join(", ")}`,
  );
  lines.push("");
  lines.push(renderFooter({}));
  return lines.join("\n");
}

function _renderMinimal() {
  return [
    bold("AgentFlow — terminal coder"),
    "",
    "Enter a task for the agent:",
    "",
    "  (press F2 for command palette, Esc to cancel)",
    "",
    "Task:",
    "",
  ].join("\n");
}

// ---- Arena/Tribunal Renderers ----

function _renderTribunalStage(stageNum, stageResult, isCurrent = false) {
  const lines = [];
  const stageName = PIPELINE_ROUNDS[stageNum - 1] || `stage-${stageNum}`;
  const statusColor = isCurrent
    ? stageResult && stageResult.status === "COMPLETED"
      ? green
      : yellow
    : dim;
  const statusText = stageResult ? statusColor(stageResult.status) : "—";

  lines.push(`  round ${stageNum}: ${stageName} ${statusText}`);

  if (stageResult) {
    if (stageResult.status === "COMPLETED") {
      if (stageNum === 1) {
        lines.push(
          `    reviewed: ${stageResult.candidates?.length ?? 0}/${stageResult.summary?.total ?? 0}`,
        );
        const reviewed = stageResult.candidates?.filter(
          (c) => c.outcome === STAGE_OUTCOME.REVIEWED,
        ).length;
        lines.push(`    validated: ${reviewed}`);
      } else if (stageNum === 2) {
        lines.push(`    findings: ${stageResult.summary?.total ?? 0} total`);
        if (stageResult.candidates?.[0]) {
          lines.push(`    survival: ${stageResult.candidates[0].survivalScore ?? 0}`);
        }
      } else if (stageNum === 3) {
        lines.push(`    decision: ${stageResult.result?.decision ?? "—"}`);
        if (stageResult.criticalFindings) {
          lines.push(`    critical findings: ${stageResult.criticalFindings.length}`);
        }
      } else if (stageNum === 4) {
        lines.push(`    verdict: ${stageResult.outcome?.verdict ?? "—"}`);
        if (stageResult.outcome) {
          lines.push(`    confidence: ${stageResult.outcome.confidence ?? 0}`);
        }
      } else if (stageNum === 5) {
        lines.push(`    verdict: ${stageResult.oracleResult?.verdict ?? "—"}`);
        if (stageResult.oracleResult) {
          lines.push(`    confidence: ${stageResult.oracleResult.confidence ?? 0}`);
          lines.push(`    final output: ${stageResult.oracleResult.final_output ?? "—"}`);
        }
      }
    }
  }

  lines.push("");
  return lines;
}

function _renderBattleReport(battleReport) {
  const lines = [];
  if (!battleReport) {
    lines.push(`  no battle report`);
    lines.push(`  rounds: none`);
    return lines;
  }

  lines.push(`  winner: ${battleReport.winner ?? "—"}`);
  lines.push(`  rounds: ${battleReport.rounds.length}`);
  lines.push(`  total findings: ${battleReport.total_findings}`);
  lines.push(`  resolved: ${battleReport.resolved_findings}/${battleReport.unresolved_critical}`);

  if (battleReport.rounds && battleReport.rounds.length > 0) {
    for (const round of battleReport.rounds) {
      lines.push(`    round ${round.round_number} (${round.stage}): ${round.events.join(", ")}`);
    }
  }

  lines.push("");
  return lines;
}

function _renderOracleSummary(oracleResult) {
  const lines = [];
  if (!oracleResult) {
    lines.push(`  no oracle result`);
    return lines;
  }

  lines.push(`  verdict: ${oracleResult.verdict ?? "—"}`);
  lines.push(`  confidence: ${oracleResult.confidence ?? 0}`);
  lines.push(`  final output: ${oracleResult.final_output ?? "—"}`);
  lines.push(`  caveats: ${oracleResult.caveats?.length ?? 0}`);

  if (oracleResult.battle_report) {
    lines.push(`  battle report: ${oracleResult.battle_report.winner ?? "—"}`);
    lines.push(`  rounds: ${oracleResult.battle_report.rounds.length}`);
  }

  lines.push("");
  return lines;
}

// ---- Runtime orchestration ----

/**
 * Run the agent with real-time TUI updates.
 * Manually steps through the runtime's iteration loop, updating display after each step.
 */
async function runAgentWithTUI({ agentId, task, _sessionId = null, flags = {} } = {}) {
  const reg = new AgentRegistry(builtinSpecs());
  const agent = reg.get(agentId);
  const config = {};

  const workspace = resolveWorkspaceRoot({
    explicit: flags.workspace ? String(flags.workspace) : null,
    projectRoot: flags.project ? String(flags.project) : null,
    cwd: process.cwd(),
  });

  const blackboard = new BlackboardStore({
    dir: flags["blackboard-dir"] ? String(flags["blackboard-dir"]) : defaultBlackboardDir(),
    projectRoot: workspace.root,
  });

  const modelHints = (_config) => {
    const raw = _config?.modelHints;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [modelId, hint] of Object.entries(raw)) {
      if (modelId && hint && typeof hint === "object" && !Array.isArray(hint)) out[modelId] = hint;
    }
    return out;
  };

  const health = new ProviderHealth({});
  const limiter = new RollingWindowLimiter({
    limits: rateLimitsFromRegistry(PROVIDERS),
    windowMs: config.requestRateWindowMs,
    maxWaitMs: config.maxRateLimitWaitMs,
  });
  const usageLedger = new UsageLedger({});

  let catalogue = [];
  try {
    catalogue = await listModels(config);
  } catch {
    /* optional */
  }

  const sessions = new SessionStore({
    dir: flags["state-dir"] ? String(flags["state-dir"]) : defaultSessionsDir(),
  });

  const _blackboardStore = new BlackboardStore({
    dir: flags["blackboard-dir"] ? String(flags["blackboard-dir"]) : defaultBlackboardDir(),
    projectRoot: workspace.root,
  });
  if (!blackboard.exists()) {
    try {
      blackboard.create({ goal: task, objective: `agent run in ${workspace.root}` });
    } catch {
      /* best-effort */
    }
  }

  let sid = flags.session ? String(flags.session) : null;
  if (!sid) {
    try {
      sid = sessions.create({ objective: task, projectRoot: workspace.root, agents: [agentId] });
    } catch {
      /* session unavailable is a degraded run, not a failure */
    }
  }

  const approver = makeApprover(flags);
  const tools = createRealTools();

  const runtime = new AgentRuntime({
    registry: reg,
    tools,
    complete: (cfg, modelId, prompt, opts) => complete(cfg, modelId, prompt, opts),
    catalogue,
    hints: modelHints(config),
    log: { emit: () => {} },
    config,
    providerHealth: health,
    limiter,
    usageLedger,
    approver,
    workspaceRoot: workspace,
    blackboard,
    sessions,
  });

  const bounds = agent.bounds;
  const startedAt = Date.now();
  let iteration = 0;
  let output = null;
  let transcript = [];
  let _continuationAttempted = false;
  let result = null;

  function _renderTUI() {
    return renderProgress(resultState(result));
  }

  function emit(_type, _payload) {
    // Could wire to TUI event log here
  }

  try {
    const _boardSummary =
      typeof blackboard.get === "function" ? blackboard.get() : blackboard.summary?.() || {};
    const context = buildAgentContext({
      agent,
      blackboard,
      session: sid ? await sessions.read(sid) : null,
      task,
    });
    result = { ...initialState(), contextPresent: true };

    const plan = await runtime.resolveModelPlan(agent, {
      catalogue,
      hints: modelHints(config),
      preferFree: true,
      allowPaidFallback: false,
    });
    result.plan = plan;

    runtime.transition(result, "running", agent);
    emit("agent.start", { agentId: agent.id, bounds });

    for (let iter = 1; iter <= bounds.maxIterations; iter++) {
      iteration = iter;
      result.iterations = iter;

      if (process.aborted) {
        result.cancelled = true;
        result.state = "cancelled";
        break;
      }
      if (Date.now() - startedAt > bounds.timeoutMs) {
        result.timedOut = true;
        result.state = "timed_out";
        break;
      }
      if (result.toolCalls > bounds.maxToolCalls) {
        throw new Error(
          `maxToolCalls exceeded: ${result.toolCalls} > ${bounds.maxToolCalls}`,
        );
      }

      const _currentPrompt = runtime.buildPrompt(agent, context, task, iter, transcript);

      let receipt;
      try {
        receipt = await runtime.route({
          signal: null,
          onAttempt: () => {},
        });
      } catch (e) {
        result.state = "failed";
        result.error = { code: "agent_error", message: String(e) };
        break;
      }

      result.model = receipt?.model;
      result.toolCalls =
        (result.toolCalls || 0) + (receipt?.toolCalls ? receipt.toolCalls.length : 0);

      emit("agent.model_selected", {
        agentId: agent.id,
        model: receipt?.model,
        tier: receipt?.tier,
        iteration,
      });

      const requested = runtime.parseToolCalls(receipt?.value);
      if (requested && requested.length) {
        for (const call of requested) {
          const tool = tools.get(call.tool);
          if (!tool) {
            result.state = "failed";
            result.error = { code: "tool_denied", message: `no such tool: ${call.tool}` };
            break;
          }

          const perm = await runtime.evaluatePermission(agent, tool, call, { approver });

          if (perm.decision === "deny") {
            result.state = "failed";
            result.error = { code: "tool_denied", message: perm.reason };
            break;
          }

          if (perm.decision === "ask") {
            const approved = await new Promise((resolve) => {
              const question = `  allow ${call.tool} ${truncate(JSON.stringify(call.args), 80)}? [y/Allow always/n/Deny]`;
              process.stderr.write(`${question}\n`);
              process.stdin.once("keypress", (str, key) => {
                const choice = interpretChoice(key.str);
                if (choice === "allow-once") resolve(true);
                if (choice === "allow-always") resolve(true);
                if (choice === "deny") resolve(false);
                resolve(false); // fail-closed
              });
            });

            if (!approved) {
              result.state = "failed";
              result.error = { code: "tool_denied", message: "approval denied" };
              break;
            }
          }

          const outcome = await runtime.runTool(
            agent,
            tool,
            call,
            {
              preExecute: [],
              guards: [],
              execute: [],
              postExecute: [],
              approver,
              log: { emit: () => {} },
              onDecision: () => {},
              onDispatch: () => {},
            },
          );

          if (!result.toolResults) result.toolResults = [];
          result.toolResults.push({
            outcome: outcome.outcome,
            tool: call.tool,
            scope: tool.scope,
            output: outcome.output,
            approved: Boolean(outcome.approval?.granted),
            error: outcome.error?.message ?? null,
          });

          result.toolCalls = (result.toolCalls || 0) + 1;
          transcript.push({ tool: call.tool, outcome: outcome.outcome, scope: tool.scope });
          break;
        }

        if (result.state === "failed") break;

        continue;
      }

      output = receipt?.value;
      break;
    }

    if (output === null && result.state !== "failed" && result.state !== "timed_out" && result.state !== "cancelled") {
      result.state = "failed";
      result.error = { code: "no_output", message: "the agent produced no output" };
    }

    if (result.completed !== true && result.state !== "failed") {
      result.completed = true;
    }

    result.durationMs = Date.now() - startedAt;
  } catch (err) {
    result.state = "failed";
    result.error = { code: err.code || "agent_error", message: err.message || String(err) };
    result.timedOut = false;
    result.cancelled = false;
  }

  return result;
}

export async function runTUI(flags = {}) {
  const TTY = process.stdout.isTTY;
  if (!TTY) {
    process.stderr.write("aflow terminal requires an interactive terminal (stdout is not a TTY)\n");
    process.exit(1);
  }

  process.stdout.write("\u001b[?1049h\u001b[2J");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.resume();

  const cleanup = () => {
    rl.close();
    process.stdout.write("\u001b[?1049l");
    process.stdout.write("\u001b[0m");
  };

  try {
    process.stdout.write("\u001b[2J\u001b[H");

    const _modelItems = buildModelItems();
    const modelDialogSpec = createModelDialogSpec();

    let selectedModel = null;
    if (modelDialogSpec) {
      const { value } = await selectFromList(modelDialogSpec.items, {
        title: "Select model",
        prompt: "Search models (or press Enter to use default):",
      });
      selectedModel = value;
    }

    const model = selectedModel || "openai/gpt-4o";

    const task = await new Promise((resolve) => {
      const prompt = "Enter your coding task (or press Enter for a sample task): ";
      process.stdout.write(prompt);
      rl.question(prompt, (line) => {
        const task = line.trim();
        if (!task) {
          resolve("Fix the null dereference in src/core/agents/runtime.js and run the test suite");
        } else {
          resolve(task);
        }
      });
    });

    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write(head("Initializing agent…"));

    const tuiFlags = {
      model: model,
      workspace: flags.workspace,
      project: flags.project,
      yes: flags.yes,
      deny: flags.deny,
    };

    const result = await runAgentWithTUI({
      agentId: flags.agentId || "coder",
      task,
      _sessionId: flags.session,
      flags: tuiFlags,
    });

    let tribunalResult = null;
    let _battleReport = null;
    let _oracleSummary = null;

    const workspace = resolveWorkspaceRoot({ cwd: process.cwd() });
    const blackboard = new BlackboardStore({
      dir: defaultBlackboardDir(),
      projectRoot: workspace.root,
    });

    if (blackboard && blackboard.exists()) {
      try {
        const _bbGoal = blackboard.goal || task;
        const _bbObjective = blackboard.objective || `agent run in ${workspace.root}`;

        const mockJudge = async (_config, modelId, prompt, opts) => {
          const system = opts?.system ?? "";

          if (/self-adversarial reviewer/.test(system)) {
            return {
              text: JSON.stringify({
                candidates: [
                  {
                    id: "c1",
                    model: modelId || "mock",
                    outcome: "reviewed",
                    iterations: 1,
                    review: {
                      reviewDecision: "RETAIN",
                      confidenceBefore: 0.9,
                      confidenceAfter: 0.8,
                      failureHypotheses: [],
                      proposedTests: [],
                      decision: "RETAIN_WITH_EVIDENCE",
                      confidenceJustification: "no material change",
                    },
                    classification: [],
                    assessment: {},
                    decision: "RETAIN_WITH_EVIDENCE",
                    revisedApproach: null,
                    traces: [],
                  },
                ],
                summary: { total: 1, reviewed: 1, invalid: 0, limited: 0, revised: 0 },
              })
            };
          }

          if (/adversarial examiner/.test(system)) {
            return {
              text: JSON.stringify({
                attacker_perspective: "code",
                target_proposal_id: "p1",
                verdict: "PASS",
                findings: [],
                summary: "the proposal held",
              })
            };
          }

          if (/neutral senior architect/.test(system)) {
            return {
              text: JSON.stringify({
                schema_version: 1,
                decision: "SYNTHESIZED",
                hybrid_solution: {
                  content: "THE HYBRID",
                  elements: [
                    { element_id: "e1", source_proposal_ids: ["p1"], rationale: "from A", addresses_findings: [] },
                    { element_id: "e2", source_proposal_ids: ["p2"], rationale: "from B", addresses_findings: [] },
                  ],
                },
                findings_resolution: [],
                discarded_elements: [],
                synthesis_notes: "merged A and B",
                insufficiency_reason: null,
              })
            };
          }

          if (/prosecutor/.test(system)) {
            return {
              text: JSON.stringify({
                schema_version: 1,
                verdict: "ACQUITTED",
                findings: [],
                prosecution_summary: "clean",
                recommended_retry_focus: null,
              })
            };
          }

          return { text: "{}" };
        };

        tribunalResult = await runFullTribunal({
          proposals: [
            { id: "p1", model: model, approach: "approach A" },
            { id: "p2", model: model, approach: "approach B" },
          ],
          completeFn: mockJudge,
          modelId: model,
          domain: "code",
        });

        if (tribunalResult && tribunalResult.oracle) {
          _battleReport = {
            rounds: PIPELINE_ROUNDS.map((stage, i) => ({
              round_number: i + 1,
              stage,
              events: [`${stage} events`],
            })),
            winner: tribunalResult.oracle.verdict === "VERIFIED" ? "THE HYBRID" : null,
            total_findings: { p0: 0, p1: 0, p2: 0, p3: 0 },
          };
        }
      } catch {
        /* tribunal integration is optional */
      }
    }

    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write(renderProgress(result));

    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}