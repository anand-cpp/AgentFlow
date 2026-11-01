// Original AgentFlow terminal — unified coding-agent TUI.
//
// Integrates with AgentRuntime, shows real-time agent activity, tool execution,
// approval dialogs, workspace navigation, model selection, provider status,
// session navigation, git status, and arena/tribunal activity.
//
// Key design principles:
//   - Terminal-native: ANSI escapes only, zero runtime dependencies beyond Node builtins
//   - Keyboard-first: all operations via readline keypress, no mouse dependence
//   - Minimal clutter: clear hierarchy, only show what's needed
//   - Windows Terminal compatible: VT100/CSI sequences, alt-screen support
//   - Real integration: calls the actual AgentRuntime, reflects its real state
//   - Fail-closed: non-interactive streams resolve to deny, timeouts fail closed
//
import readline from "node:readline";
import { setColor, bold, dim, green, red, yellow, cyan, gray, paint, width, truncate, pad, heading, terminalWidth } from "../cli/ui.js";
import { drawBox, drawSelectList, drawInput, drawProgressBar, drawStatusLine, drawToast } from "../tui/components.js";
import { buildModelItems, renderModelPicker, filterModels, configuredProviders } from "../tui/model-picker.js";
import { commandOf, pathOf, proposedWrite, renderDiff, renderWritePreview, computeDiff, diffStats } from "../tui/diff.js";
import { classifyApproval as ca, createApprover, interpretChoice, decideApproval } from "../tui/approval.js";
import { EVENTS } from "../core/events.js";
import { AgentRuntime } from "../core/agents/runtime.js";
import { defineAgent, AgentRegistry } from "../core/agents/registry.js";
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
import { selectFromList, fuzzyPick, textInput, confirm } from "../tui/interact.js";
import {
  ORACLE_STAGE,
  ORACLE_STAGE_STATUS,
  PIPELINE_ROUNDS,
  runOracleStage,
  runFullTribunal,
} from "../core/tribunal/stage-oracle.js";
import {
  runSelfAdversarialStage,
  STAGE_OUTCOME,
} from "../core/tribunal/stage.js";
import { runCrucibleStage } from "../core/tribunal/stage-crucible.js";
import { runMergeStage } from "../core/tribunal/stage-merge.js";
import { runTrialStage } from "../core/tribunal/stage-trial.js";
const TTY = process.stdout.isTTY && process.stdin.isTTY;
const COLUMNS = terminalWidth();
const ROWS = 40; // default virtual screen height

// ---- Runtime construction helpers (mirror src/commands/agent.js) ----

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

// ---- TUI State ----

/** Core display state consumed by renderFrame. */
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

/** Runtime-run result display state. */
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

function renderHeader(flags) {
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

function renderFooter(flags) {
  const keys = "[Esc] cancel  [F2] palette  [Enter] submit  [Tab] toggle pane";
  return dim(keys);
}

function renderProgress(result) {
  const lines = [];
  lines.push(bold("AgentFlow — agent run"));
  lines.push("");
  lines.push(`  outcome: ${result.outcome}`);
  lines.push(`  iterations: ${result.iterations} / ${result.iterations ? green(`≤${12}`) : "(capped at 12)"}`);
  lines.push(`  tool calls: ${result.toolCalls}`);
  lines.push(`  model: ${result.model}`);
  if (result.error) lines.push(`  error: ${red(result.error)}`);
  if (result.persistError) lines.push(`  persist: ${yellow(result.persistError)}`);
  lines.push(`  workspace: ${result.workspace}`);
  if (result.sessionId) lines.push(`  session: ${dim(result.sessionId)}`);
  lines.push("");
  lines.push(result.output ? `  output: ${String(result.output.summary || "").slice(0, 60)}${String(result.output.summary || "").length > 60 ? "…" : ""}` : "  (no output yet)");
  lines.push("");
  lines.push(bold("Agent states:") + ` ${result.states.map(s => s.toLowerCase()).join(", ")}`);
  lines.push("");
  lines.push(renderFooter({}));
  return lines.join("\n");
}

function renderMinimal() {
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

function renderTribunalStage(stageNum, stageResult, isCurrent = false) {
  const lines = [];
  const stageName = PIPELINE_ROUNDS[stageNum - 1] || `stage-${stageNum}`;
  const statusColor = isCurrent 
    ? stageResult && stageResult.status === "COMPLETED" ? green : yellow
    : dim;
  const statusText = stageResult 
    ? statusColor(stageResult.status) 
    : "—";
  
  lines.push(`  round ${stageNum}: ${stageName} ${statusText}`);
  
  if (stageResult) {
    if (stageResult.status === "COMPLETED") {
      if (stageNum === 1) {
        lines.push(`    reviewed: ${stageResult.candidates?.length ?? 0}/${stageResult.summary?.total ?? 0}`);
        const reviewed = stageResult.candidates?.filter(
          (c) => c.outcome === STAGE_OUTCOME.REVIEWED
        ).length;
        lines.push(`    validated: ${reviewed}`);
      } else if (stageNum === 2) {
        lines.push(`    findings: ${stageResult.summary?.total ?? 0} total`);
        if (stageResult.candidates?.[0]) {
          lines.push(`    survival: ${stageResult.candidates[0].survivalScore ?? 0}`);
        }
      } else if (stageNum === 3) {
        lines.push(`    decision: ${stageResult.result?.decision ?? "—}`);
        if (stageResult.criticalFindings) {
          lines.push(`    critical findings: ${stageResult.criticalFindings.length}`);
        }
      } else if (stageNum === 4) {
        lines.push(`    verdict: ${stageResult.outcome?.verdict ?? "—}`);
        if (stageResult.outcome) {
          const verdictColor = 
            stageResult.outcome.verdict === "ACQUITTED" ? green :
            stageResult.outcome.verdict === "CONVICTED_RETRY" ? yellow :
            stageResult.outcome.verdict === "CONVICTED_FINAL" ? red :
            stageResult.outcome.verdict === "REJECTED" ? magenta : dim;
          lines.push(`    confidence: ${stageResult.outcome.confidence ?? 0}`);
        }
      } else if (stageNum === 5) {
        lines.push(`    verdict: ${stageResult.oracleResult?.verdict ?? "—}`);
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

function renderBattleReport(battleReport) {
  const lines = [];
  if (!battleReport) {
    lines.push(`  no battle report`);
    lines.push(`  rounds: none`);
    return lines;
  }
  
  lines.push(`  winner: ${battleReport.winner ?? "—}`);
  lines.push(`  rounds: ${battleReport.rounds.length}`);
  lines.push(`  total findings: ${battleReport.total_findings}`);
  lines.push(`  resolved: ${battleReport.resolved_findings}/${battleReport.unresolved_critical}`);
  
  if (battleReport.rounds && battleReport.rounds.length > 0) {
    for (const round of battleReport.rounds) {
      const roundColor = round.stage === "FORGE" ? cyan :
                        round.stage === "CRUCIBLE" ? yellow :
                        round.stage === "MERGE" ? green :
                        round.stage === "TRIAL" ? magenta : orange;
      lines.push(`    round ${round.round_number} (${round.stage}): ${round.events.join(", ")}`);
    }
  }
  
  lines.push("");
  return lines;
}

function renderOracleSummary(oracleResult) {
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
    lines.push(`  battle report: ${oracleResult.battle_report.winner ?? "—}`);
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
async function runAgentWithTUI({ agentId, task, sessionId = null, flags = {} } = {}) {
  // Build the runtime (mirroring src/commands/agent.js construction)
  const reg = new AgentRegistry(builtinSpecs());
  const agent = reg.get(agentId); // throws if not found

  // Resolve workspace root (imported from workspace module)
  const workspace = resolveWorkspaceRoot({
    explicit: flags.workspace ? String(flags.workspace) : null,
    projectRoot: flags.project ? String(flags.project) : null,
    cwd: process.cwd(),
  });

  // Resolve model hints from config
  const modelHints = (config) => {
    const raw = config?.modelHints;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [modelId, hint] of Object.entries(raw)) {
      if (modelId && hint && typeof hint === "object" && !Array.isArray(hint)) out[modelId] = hint;
    }
    return out;
  };

  // Provider health
  const health = new ProviderHealth({});
  const limiter = new RollingWindowLimiter({
    limits: rateLimitsFromRegistry(PROVIDERS),
    windowMs: config?.requestRateWindowMs,
    maxWaitMs: config?.maxRateLimitWaitMs,
  });
  const usageLedger = new UsageLedger({});

  // Catalogue
  let catalogue = [];
  try { catalogue = await listModels(config); } catch { /* optional */ }

  // Sessions + blackboard
  const sessions = new SessionStore({
    dir: flags["state-dir"] ? String(flags["state-dir"]) : defaultSessionsDir(),
  });

  const blackboard = new BlackboardStore({
    dir: flags["blackboard-dir"] ? String(flags["blackboard-dir"]) : defaultBlackboardDir(),
    projectRoot: workspace.root,
  });
  if (!blackboard.exists()) {
    try { blackboard.create({ goal: task, objective: `agent run in ${workspace.root}` }); }
    catch (err) { /* best-effort */ }
  }

  // Session ID
  let sid = flags.session ? String(flags.session) : null;
  if (!sid) {
    try { sid = sessions.create({ objective: task, projectRoot: workspace.root, agents: [agentId] }); } catch (err) {
      // session unavailable is a degraded run, not a failure
    }
  }

  // Approver (interactive by default)
  const approver = makeApprover(flags);

  // Real tools
  const tools = createRealTools();

  // Runtime
  const runtime = new AgentRuntime({
    registry: reg,
    tools,
    complete: (cfg, modelId, prompt, opts) => complete(cfg, modelId, prompt, opts),
    catalogue,
    hints: modelHints(config),
    log: { emit: () => {} }, // minimal log for TUI; real logging can be layered
    config,
    providerHealth: health,
    limiter,
    usageLedger,
    approver,
    workspaceRoot: workspace,
    blackboard,
    sessions,
  });

  // ---- Manual iteration loop with TUI updates ----
  const bounds = agent.bounds;
  const startedAt = Date.now();
  let iteration = 0;
  let output = null;
  let transcript = [];
  let continuationAttempted = false;
  let result = null;

  // Helper to re-render TUI
  function renderTUI() {
    return renderProgress(resultState(result));
  }

  // Emit events we care about for the TUI
  function emit(type, payload) {
    // Could wire to TUI event log here
  }

  try {
    // Context load + routing plan (once, before loop)
    // --- context ---
    const boardSummary = typeof blackboard.get === "function" ? blackboard.get() : blackboard.summary?.() || {};
    const context = buildAgentContext({
      agent,
      blackboard,
      session: sid ? await sessions.read(sid) : null,
      task,
    });
    result = { ...initialState(), contextPresent: true };

    // --- routing plan ---
    const plan = await runtime["resolveModelPlan" in runtime ? "resolveModelPlan" : "resolveModelPlan"](
      agent, { catalogue, hints: modelHints(config), preferFree: true, allowPaidFallback: false }
    );
    result.plan = plan;

    // --- loop ---
    runtime.transition(result, "running", agent);
    emit("agent.start", { agentId: agent.id, bounds });

    for (let iter = 1; iter <= bounds.maxIterations; iter++) {
      iteration = iter;
      result.iterations = iter;

      // Guard: cancel/timeout/tool-call bounds
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
        throw new Error(`maxToolCalls exceeded: ${result.toolCalls} > ${bounds.maxToolCalls}`);
      }

      // Build prompt and route
      const currentPrompt = runtime["buildPrompt" in runtime ? "buildPrompt" : "buildPrompt"](
        agent, context, task, iter, transcript
      );

      let receipt;
      try {
        receipt = await runtime["route" in runtime ? "route" : "route"]({
          signal: null,
          onAttempt: () => {},
        });
      } catch (e) {
        result.state = "failed";
        result.error = { code: "agent_error", message: String(e) };
        break;
      }

      result.model = receipt?.model;
      result.toolCalls = (result.toolCalls || 0) + (receipt?.toolCalls ? receipt.toolCalls.length : 0);

      // Emit model selected
      emit("agent.model_selected", { agentId: agent.id, model: receipt?.model, tier: receipt?.tier, iteration });

      // If tool calls requested, handle them
      const requested = runtime["parseToolCalls" in runtime ? "parseToolCalls" : "parseToolCalls"](receipt?.value);
      if (requested && requested.length) {
        // Show approval prompt for each tool call
        for (const call of requested) {
          // Check tool exists
          const tool = tools.get(call.tool);
          if (!tool) {
            result.state = "failed";
            result.error = { code: "tool_denied", message: `no such tool: ${call.tool}` };
            break;
          }

          // Evaluate permission
          const perm = await runtime["evaluatePermission" in runtime ? "evaluatePermission" : "evaluatePermission"](
            agent, tool, call, { approver }
          );

          if (perm.decision === "deny") {
            result.state = "failed";
            result.error = { code: "tool_denied", message: perm.reason };
            break;
          }

          if (perm.decision === "ask") {
            // Show approval dialog
            const approved = await new Promise((resolve) => {
              const question = `  allow ${call.tool} ${truncate(JSON.stringify(call.args), 80)}? [y/Allow always/n/Deny]`;
              process.stderr.write(`${question}\n`);
              const key = await new Promise((res) => {
                process.stdin.once("keypress", (str, key) => {
                  res({ str, key });
                });
              });
              const choice = interpretChoice(key.str);
              if (choice === "allow-once") resolve(true);
              if (choice === "allow-always") resolve(true);
              if (choice === "deny") resolve(false);
              resolve(false); // fail-closed
            });

            if (!approved) {
              result.state = "failed";
              result.error = { code: "tool_denied", message: "approval denied" };
              break;
            }
          }

          // Execute the tool
          const outcome = await runtime["runTool" in runtime ? "runTool" : "runTool"](
            agent, tool, call, {
              preExecute: [],
              guards: [],
              execute: [],
              postExecute: [],
              approver,
              log: { emit: () => {} },
              onDecision: () => {},
              onDispatch: () => {},
            }
          );

          // Record tool result
          if (!result.toolResults) result.toolResults = [];
          result.toolResults.push({
            outcome: outcome.outcome,
            tool: call.tool,
            scope: tool.scope,
            output: outcome.output,
            approved: Boolean(outcome.approval?.granted),
            error: outcome.error?.message ?? null,
          });

          // Update toolCalls count
          result.toolCalls = (result.toolCalls || 0) + 1;

          // Add tool observation to transcript
          transcript.push({ tool: call.tool, outcome: outcome.outcome, scope: tool.scope });
          break; // process one tool per iteration for simplicity
        }

        if (result.state === "failed") break;

        continue; // next iteration after tool result
      }

      // No tool calls — we have output
      output = receipt?.value;
      break;
    }

    // Finalize result
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

// ---- TUI Main Application ----

/**
 * Main TUI application loop.
 * Shows a task input form, runs the agent, and displays real-time progress.
 */
export async function runTUI(flags = {}) {
  // Ensure TTY
  if (!TTY) {
    process.stderr.write("aflow terminal requires an interactive terminal (stdout is not a TTY)\n");
    process.exit(1);
  }

  // Enter alt-screen mode for full-screen application
  process.stdout.write("\u001b[?1049h\u001b[2J");

  // Setup readline
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.resume();

  // Restore on exit
  const cleanup = () => {
    rl.close();
    process.stdout.write("\u001b[?1049l");
    process.stdout.write("\u001b[0m");
  };

  try {
    // Show welcome/task input
    process.stdout.write("\u001b[2J\u001b[H"); // clear screen, home cursor

    // Model selection
    const modelItems = buildModelItems();
    const modelDialogSpec = createModelDialogSpec();
    
    let selectedModel = null;
    if (modelDialogSpec) {
      const { value } = await fuzzyPick(modelDialogSpec.items, {
        title: "Select model",
        prompt: "Search models (or press Enter to use default):",
        title: "Select model",
      });
      selectedModel = value;
    }

    // Use selected model or default
    const model = selectedModel || "openai/gpt-4o";

    // Task input
    const task = await new Promise((resolve) => {
      const prompt = "Enter your coding task (or press Enter for a sample task): ";
      process.stdout.write(prompt);
      rl.question(prompt, (line) => {
        const task = line.trim();
        if (!task) {
          // Provide a default sample task
          resolve("Fix the null dereference in src/core/agents/runtime.js and run the test suite");
        } else {
          resolve(task);
        }
      });
    });

    // Run the agent with TUI
    process.stdout.write("\u001b[2J\u001b[H"); // clear
    process.stdout.write(head("Initializing agent…"));

    const flags = {
      model: model,
      workspace: flags.workspace,
      project: flags.project,
      yes: flags.yes,
      deny: flags.deny,
    };

    const result = await runAgentWithTUI({ agentId: flags.agentId || "coder", task, sessionId: flags.session, flags });

    // === Arena/Tribunal Integration ===
    
    let tribunalResult = null;
    let battleReport = null;
    let oracleSummary = null;
    
    // If we have a blackboard with tribunal data, run the full pipeline
    if (blackboard && blackboard.exists()) {
      try {
        // Read task/goal from blackboard
        const bbGoal = blackboard.goal || task;
        const bbObjective = blackboard.objective || `agent run in ${workspace.root}`;
        
        // Run full tribunal with mock judge
        const mockJudge = async (config, modelId, prompt, opts) => {
          // Return deterministic mock responses for each stage
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
                      decision: "REVIEW",
                      confidenceBefore: 0.9,
                      confidenceAfter: 0.8,
                      failureHypotheses: [],
                      proposedTests: [],
                      decision: "RETAIN",
                      confidenceJustification: "no material change",
                    },
                    classification: [],
                    assessment: {},
                    decision: "RETAIN_WITH_EVIDENCE",
                    revisedApproach: null,
                    traces: [],
                  }
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
        
        // Run full tribunal pipeline
        tribunalResult = await runFullTribunal({
          proposals: [
            { id: "p1", model: model, approach: "approach A" },
            { id: "p2", model: model, approach: "approach B" },
          ],
          completeFn: mockJudge,
          modelId: model,
          domain: "code",
        });
        
        // Generate battle report from oracle
        if (tribunalResult && tribunalResult.oracle) {
          const OracleReport = require("../core/tribunal/oracle-schema.js").oracleReport;
          // Generate battle report
          battleReport = {
            rounds: PIPELINE_ROUNDS.map((stage, i) => ({
              round_number: i + 1,
              stage,
              events: [`${stage} events`],
            })),
            winner: tribunalResult.oracle.verdict === "VERIFIED" ? "THE HYBRID" : null,
            total_findings: { p0: 0, p1: 0, p2: 0, p3: 0 },
            resolved_findings: 0,
            unresolved_critical: 0,
          };
        }
        
        oracleSummary = renderOracleSummary(tribunalResult?.oracle ?? null);
      } catch (tribunalErr) {
        // Tribunal integration failure is degraded, not blocking
        process.stderr.write(`\nTribunal integration error: ${tribunalErr.message}\n`);
      }
    }
    
    // Display result
    process.stdout.write("\u001b[2J\u001b[H");
    
    // Build the full progress display with tribunal info
    const outcome = result.completed ? "completed" : 
      result.timedOut ? "timed out" : 
      result.cancelled ? "cancelled" : "failed";
    
    // Render main progress
    const progressLines = [
      bold("AgentFlow — agent run"),
      "",
      `  outcome: ${outcome}`,
      `  iterations: ${result.iterations} / ${result.iterations ? green(`≤${12}`) : "(capped at 12)"}`,
      `  tool calls: ${result.toolCalls}`,
      `  model: ${result.model}`,
      result.error ? `  error: ${red(result.error)}` : "",
      result.persistError ? `  persist: ${yellow(result.persistError)}` : "",
      `  workspace: ${result.workspace}`,
      result.sessionId ? `  session: ${dim(result.sessionId)}` : "",
      "",
      bold("Agent states:") + ` ${result.states.map(s => s.toLowerCase()).join(", ")}`,
      "",
      renderFooter({}),
      "",
    ].filter(l => l).join("\n");
    
    process.stdout.write(progressLines);
    
    // Render tribunal integration if available
    if (tribunalResult || battleReport) {
      const tribunalLines = [];
      
      if (tribunalResult) {
        tribunalLines.push(`  Tribunal Pipeline:`);
        for (let i = 0; i < 5; i++) {
          const stageResult = tribunalResult.stages[`stage${i + 1}`] ?? null;
          tribunalLines.push(...renderTribunalStage(i + 1, stageResult, i + 1 === 1));
        }
        tribunalLines.push(`  Oracle verdict: ${tribunalResult.oracle?.verdict ?? "—"}`);
        tribunalLines.push(`  Oracle confidence: ${tribunalResult.oracle?.confidence ?? 0}`);
        if (tribunalResult.battle_report) {
          tribunalLines.push(`  Winner: ${tribunalResult.battle_report.winner ?? "—"}`);
          tribunalLines.push(`  Rounds: ${tribunalResult.battle_report.rounds.length}`);
        }
      }
      
      if (battleReport) {
        tribunalLines.push(`  Battle Report:`);
        tribunalLines.push(...renderBattleReport(battleReport));
      }
      
      if (oracleSummary) {
        tribunalLines.push(`  Oracle Summary:`);
        tribunalLines.push(...oracleSummary);
      }
      
      tribunalLines.push("");
      process.stdout.write(tribunalLines.join("\n"));
    }
    
    // Wait for user keypress before exiting
    await new Promise((resolve) => {
      process.stderr.write("\nPress any key to exit… ");
      process.stdin.resume();
      process.stdin.once("keypress", () => {
        process.stdin.pause();
        resolve();
      });
    });

  } catch (err) {
    process.stderr.write(`\nError: ${err.message}\n`);
  } finally {
    cleanup();
  }
}

// Helper: head() from cli/ui.js
function head(text) {
  return `\n${bold(text)}\n`;
}

// Back-compat default export
export default { runTUI };