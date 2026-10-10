// `aflow agent` -- the built-in agent fleet.
//
//   aflow agent                      list what is available
//   aflow agent show <id>            one agent's declaration in full
//   aflow agent run <id> "<task>"    execute it
//
// `list` and `show` are the discovery surface, and they are read-only on purpose:
// before running an agent that can write files and run commands, you should be able
// to see exactly what it is allowed to do. `show` prints the scopes, the allow
// list and the approval gates verbatim, because "can this thing touch my
// repository" should be answerable without reading source.
//
// `run` is the only subcommand that dispatches to a provider, and it composes the
// existing pieces rather than reimplementing any of them:
//
//   registry (builtins)  -> what the agent is and what it may do
//   requirements         -> which models could satisfy it
//   Router (per run)     -> which one actually answers
//   gateway.complete     -> the answer
//   context              -> Session + Blackboard, bounded and redacted
//   tools.js             -> every tool call, judged before it runs
//   Session/Blackboard   -> where the result is recorded
//
// Approvals are interactive by default and fail closed without a terminal. `--yes`
// approves everything, which is a real decision and not a convenience flag, so it
// has to be typed on purpose.

import process from "node:process";
import readline from "node:readline/promises";
import { defineCommand } from "../cli/registry.js";
import { builtinSpecs } from "../core/agents/definitions.js";
import { AgentRegistry, TOOL_SCOPE } from "../core/agents/registry.js";
import { AgentRuntime, STATE } from "../core/agents/runtime.js";
import { resolveWorkspaceRoot, ROOT_SOURCE } from "../core/agents/workspace.js";
import { createRealTools } from "../core/agents/real-tools.js";
import { Router } from "../core/routing.js";
import { complete, listModels } from "../core/gateway.js";
import { EventLog, defaultLogPath } from "../core/events.js";
import { SessionStore, defaultSessionsDir } from "../core/sessions.js";
import { BlackboardStore, defaultBlackboardDir } from "../core/blackboard.js";
import { bold, dim, heading, table, green, red, yellow, cyan, truncate } from "../cli/ui.js";

const USAGE_ERROR = 2;
const NOT_COMPLETED = 1;

function usage(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function registry() {
  return new AgentRegistry(builtinSpecs());
}

/**
 * Declared model hints, defensively normalised.
 *
 * `checkRequirements` treats a hint as a capability grant, so a malformed entry must
 * not throw here: a typo in config would otherwise turn "this model is missing a
 * capability" into "the CLI crashed", and the operator would be debugging the wrong
 * thing. Non-object entries are dropped rather than passed on.
 */
function modelHints(config) {
  const raw = config?.modelHints;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [modelId, hint] of Object.entries(raw)) {
    if (modelId && hint && typeof hint === "object" && !Array.isArray(hint)) out[modelId] = hint;
  }
  return out;
}

/**
 * A one-word privilege summary, derived from the scopes rather than declared.
 *
 * SHELL counts as elevating even without write. That is the correction this function
 * exists to make: Release has no write scope, so a naive read/write/shell split
 * labelled it "read-only" -- next to an agent that can run `git push` on approval.
 * A summary that understates an agent's reach is worse than no summary, because it
 * is the thing someone reads instead of running `aflow agent show`.
 */
function privilege(agent) {
  const scopes = agent.tools.scopes;
  if (scopes.includes(TOOL_SCOPE.WRITE) && scopes.includes(TOOL_SCOPE.SHELL)) return "high";
  if (scopes.includes(TOOL_SCOPE.WRITE) || scopes.includes(TOOL_SCOPE.SHELL) || scopes.includes(TOOL_SCOPE.NETWORK)) {
    return "elevated";
  }
  return "read-only";
}

function privilegeColor(level) {
  if (level === "high") return red(level);
  if (level === "elevated") return yellow(level);
  return green(level);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listSub(out, flags) {
  const agents = registry().list();
  return out.init(
    {
      count: agents.length,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        purpose: a.purpose,
        capabilities: a.capabilities,
        scopes: a.tools.scopes,
        privilege: privilege(a),
        bounds: a.bounds,
      })),
    },
    (r) => {
      const lines = [heading(bold("aflow agent")), ""];
      const idWidth = Math.min(Math.max(...r.agents.map((a) => a.id.length)), 16);

      for (const a of r.agents) {
        lines.push(
          `${cyan(a.id.padEnd(idWidth))}  ${privilegeColor(a.privilege).padEnd(14)} ${dim(a.purpose)}`,
        );
      }

      lines.push("", dim(`${r.count} built-in agent(s)`));
      lines.push(dim("detail:     aflow agent show <id>"));
      lines.push(dim("run:        aflow agent run <id> \"the task\""));
      lines.push("");
      lines.push(dim("Scopes decide what an agent may do, not its instructions. Show an"));
      lines.push(dim("agent before running it if that distinction is new to you."));
      return lines.join("\n");
    },
  );
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function showSub(args, out) {
  const id = args[0];
  if (!id) throw usage("which agent: aflow agent show <id>");

  const reg = registry();
  const agent = reg.get(id); // throws AgentNotFoundError, which the router renders
  const policy = agent.tools;

  return out.init(
    {
      agent: {
        id: agent.id,
        name: agent.name,
        purpose: agent.purpose,
        instructions: agent.instructions,
        capabilities: agent.capabilities,
        model: agent.model,
        routing: agent.routing,
        bounds: agent.bounds,
        failure: agent.failure,
        tools: policy,
        input: agent.input,
        output: agent.output,
      },
      privilege: privilege(agent),
    },
    (r) => {
      const a = r.agent;
      const lines = [heading(bold(`aflow agent show ${a.id}`)), ""];

      lines.push(
        table(
          [
            { k: "name", v: a.name },
            { k: "purpose", v: a.purpose },
            { k: "privilege", v: privilegeColor(r.privilege) },
            { k: "capabilities", v: a.capabilities.join(", ") },
            { k: "scopes", v: a.tools.scopes.length ? a.tools.scopes.join(", ") : dim("(none)") },
          ],
          [
            { key: "k", label: "" },
            { key: "v", label: "" },
          ],
        ),
      );

      lines.push("", bold("tools"));
      if (!a.tools.allow.length) {
        lines.push(dim("  no allowlist entries"));
      } else {
        for (const entry of a.tools.allow) lines.push(`  allow  ${entry}`);
      }
      for (const entry of a.tools.ask) lines.push(`  ${yellow("ask")}     ${entry}`);
      for (const entry of a.tools.deny) lines.push(`  ${red("deny")}    ${entry}`);
      for (const scope of a.tools.requireApproval) {
        lines.push(`  ${yellow("approve")}  every ${scope} call, allowlist included`);
      }
      // Spelled out precisely, because the three states are easy to conflate and the
      // difference between "asks" and "refused" is the whole point of the display.
      lines.push("");
      if (a.tools.requireApproval.length) {
        lines.push(dim("  Nothing in those scopes runs without approval. The allowlist above"));
        lines.push(dim("  still applies, but only after approval."));
      } else if (a.tools.ask.length) {
        lines.push(dim("  allow  runs silently     ask  needs approval     anything else is refused"));
      } else {
        lines.push(dim("  Only the allowlist runs. Anything else is refused."));
      }

      lines.push("", bold("bounds"));
      lines.push(
        table(
          [
            { k: "iterations", v: String(a.bounds.maxIterations) },
            { k: "tool calls", v: String(a.bounds.maxToolCalls) },
            { k: "timeout", v: `${Math.round(a.bounds.timeoutMs / 1000)}s` },
            { k: "context", v: `${a.bounds.maxContextChars} chars` },
            { k: "retries", v: String(a.failure.maxRetries) },
          ],
          [
            { key: "k", label: "" },
            { key: "v", label: "" },
          ],
        ),
      );

      lines.push("", bold("model"));
      lines.push(dim(`  requires: ${a.model.requireCapabilities.join(", ") || "(nothing)"}`));
      if (a.model.prefer.length) lines.push(dim(`  prefers:  ${a.model.prefer.join(", ")}`));
      if (a.model.pinModel) lines.push(dim(`  pinned:   ${a.model.pinModel}`));

      lines.push("", bold("output contract"));
      for (const f of a.output.fields) {
        const req = f.required ? green("required") : dim("optional");
        lines.push(`  ${f.name.padEnd(16)} ${dim(f.type.padEnd(8))} ${req} ${dim(truncate(f.description ?? "", 60))}`);
      }
      lines.push(dim(`  unknown fields: ${a.output.unknownFields}`));

      lines.push("", bold("input"));
      for (const f of a.input.fields) {
        const req = f.required ? green("required") : dim("optional");
        lines.push(`  ${f.name.padEnd(16)} ${dim(f.type.padEnd(8))} ${req} ${dim(truncate(f.description ?? "", 60))}`);
      }

      lines.push("", bold("instructions"), ...a.instructions.split("\n").map((l) => dim(`  ${l}`)));
      lines.push("", dim(`run it: aflow agent run ${a.id} "the task"`));
      return lines.join("\n");
    },
  );
}

// ---------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------

/**
 * An approver for `aflow agent run`.
 *
 * Fail-closed by construction: with no TTY there is nobody to ask, so the answer is
 * no rather than a hopeful guess. `--yes` turns everything on, which is why it is a
 * flag someone has to type rather than a default.
 */
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
    const answer = (await rl.question(`  allow ${call.tool} ${truncate(JSON.stringify(call.args), 90)}? [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runSub(args, flags, out, config) {
const [id, ...rest] = args;
if (!id) throw usage('which agent: aflow agent run <id> "the task"');

const task = rest.join(" ").trim() || (flags.task ? String(flags.task) : "");
if (!task) throw usage('nothing to do: aflow agent run <id> "the task"');

const reg = registry();
const agent = reg.get(id);

// Resolved once, here, and validated before anything is dispatched. The model
// never names this: containment has to be a fact about the run, not a value the
// model supplied, or an agent that wanted a wider root would simply ask for one.
// `--workspace` is explicit, `--project` is the next fallback, and the process
// cwd is the last. Whichever wins is printed, because "which tree did this run
// touch" is the first question anyone asks afterwards.
const workspace = resolveWorkspaceRoot({
explicit: flags.workspace ? String(flags.workspace) : null,
projectRoot: flags.project ? String(flags.project) : null,
cwd: process.cwd(),
});

const log = new EventLog({
  file: flags["log-file"] || config.logPath || defaultLogPath(),
  level: config.logLevel,
});

// The catalogue is best-effort context for the routing receipt -- it lets a 404
// be told apart from a bad credential. A failure here is not a reason to refuse
// to run.
let catalogue = [];
try {
  catalogue = await listModels(config);
} catch {
  /* optional */
}

const sessions = new SessionStore({
  dir: flags["state-dir"] ? String(flags["state-dir"]) : defaultSessionsDir(),
});

const blackboard = new BlackboardStore({
  dir: flags["blackboard-dir"] ? String(flags["blackboard-dir"]) : defaultBlackboardDir(),
  // Scoped to the same tree the tools are confined to. Two roots would let the
  // Blackboard record work the tools could not have reached, or vice versa.
  projectRoot: workspace.root,
});
// Created on first use for a project. Every write below is a no-op against a
// missing Blackboard, so without this the first agent run in a fresh checkout
// records a session and silently records no project state -- and the silence is
// indistinguishable from "nothing happened".
if (!blackboard.exists()) {
  try {
    blackboard.create({ goal: task, objective: `first agent run in ${workspace.root}` });
  } catch (err) {
    log.emit("agent.blackboard_unavailable", { error: err?.message ?? String(err) }, "warn");
  }
}

// A run with no session would leave the tool calls it made in no retrievable
// place, so one is created rather than skipped. Continuing an existing session
// still takes precedence: `--session` means "add to this", and silently
// starting a second store for the same task would split its history in two.
let sessionId = flags.session ? String(flags.session) : null;
if (!sessionId) {
  try {
    const created = sessions.create({
      objective: task,
      projectRoot: workspace.root,
      agents: [agent.id],
    });
    sessionId = created?.id ?? null;
  } catch (err) {
    // A session that cannot be written is a degraded run, not a failed one: the
    // task may still complete, and refusing to start would make a full disk look
    // like a broken agent. The reason travels on the result below.
    log.emit("agent.session_unavailable", { error: err?.message ?? String(err) }, "warn");
  }
}

// One runtime per run. It builds its own Router from the resolved plan, which is
// what keeps the health cache alive across iterations of a single task.
const runtime = new AgentRuntime({
  registry: reg,
  // The real implementations, keyed by the same names the registry's allowlist
  // refers to. Passing an empty Map here -- which is what this used to do --
  // meant every tool call resolved to "no such tool", so the whole permission
  // waterfall was unreachable from the CLI.
  tools: createRealTools(),
  complete: (cfg, modelId, prompt, opts) => complete(cfg, modelId, prompt, opts),
  catalogue,
  // The user's declared capability metadata. Without it an agent that requires
  // `tool_calling` can never be routed -- inference cannot reach that fact --
  // so the CLI refused to run tool-using agents no matter how healthy the
  // gateway was. Declared here rather than inferred so the source of every
  // capability decision stays inspectable.
  hints: modelHints(config),
  log,
  config,
  approver: makeApprover(flags),
  workspaceRoot: workspace,
  blackboard,
  sessions,
});

const result = await runtime.run({
  agentId: agent.id,
  task,
  sessionId,
});

// Awaited, not returned. `out.init` returns a promise, so a bare `return` would
// hand the exit code back as a resolved promise nobody reads -- and this function
// would always look like it succeeded.
await out.init(
  { agentId: agent.id, task, sessionId, workspace: workspace.describe(), result },
  (r) => {
    const res = r.result;
    const lines = [heading(bold(`aflow agent run ${r.agentId}`)), ""];

    // The four outcomes are orthogonal, so they are reported as four separate
    // facts. A run that both timed out and failed a contract is not "timed out" --
    // that reading loses the second fact.
    const facts = [];
    if (res.completed) facts.push(green("completed"));
    if (res.timedOut) facts.push(yellow("timed out"));
    if (res.cancelled) facts.push(yellow("cancelled"));
    if (!res.completed && !res.timedOut && !res.cancelled) facts.push(red("failed"));

    lines.push(
      `${bold("outcome")}  ${facts.join(dim(", "))}   ${dim(`${res.iterations} iteration(s), ${res.toolCalls} tool call(s), ${res.model ?? "no model"}`)}`,
    );

    if (res.error) lines.push(`${bold("error")}     ${red(String(res.error.message ?? res.error))}`);
    // Printed because it is the fact that makes the rest of the output auditable:
    // which tree the tools were confined to, and how that was decided.
    lines.push(`${bold("workspace")} ${r.workspace.root} ${dim(`(${r.workspace.source})`)}`);
    // A symlinked checkout resolving somewhere else is expected, but surprising
    // if unmentioned -- so it is mentioned rather than left to be discovered.
    if (r.workspace.linked) {
      lines.push(dim(`           asked for ${r.workspace.requested}`));
    }
    if (r.sessionId) lines.push(`${bold("session")}   ${dim(r.sessionId)}`);
    if (res.persistError) lines.push(`${bold("persist")}   ${yellow(res.persistError)}`);

    if (res.output) {
      lines.push("", bold("output"));
      lines.push(`  ${bold("summary")}  ${res.output.summary ?? ""}`);
      for (const [key, value] of Object.entries(res.output)) {
        if (key === "summary" || value === null || value === undefined) continue;
        lines.push(`  ${dim(key.padEnd(14))} ${formatValue(value)}`);
      }
    }

    // The bounded records, not `toolResults`. Those carry the payloads, which are
    // already in the session; this display is for "what did it do", and printing
    // a 256KB read into a terminal would answer neither question.
    if (res.toolExecutions?.length) {
      lines.push("", bold("tools"));
      for (const t of res.toolExecutions) {
        const mark =
          t.status === "ok" ? green("ok") : t.status === "denied" ? yellow("denied") : red(t.status);
        const detail = t.errorMessage || t.summary || "";
        lines.push(`  ${mark.padEnd(18)} ${dim(t.tool.padEnd(20))} ${dim(truncate(detail, 70))}`);
        if (t.truncated?.output) {
          lines.push(`  ${" ".repeat(18)} ${dim(`output bounded at ${t.truncated.limit ?? "?"} bytes`)}`);
        }
      }
    }

  lines.push("", dim(`state: ${res.state}`));
  if (res.plan) {
    lines.push(dim(`tried: ${(res.plan.attempts ?? res.plan.candidates ?? []).length} model(s)`));
  }
  lines.push(dim(`detail: aflow agent run ${r.agentId} "${truncate(r.task, 50)}" --json`));
  return lines.join("\n");
},
);

// The exit code is the last thing `run` returns, after the output. A failed run that
// exits 0 is worse than one that exits 1: it makes `aflow agent run` usable in a
// `&&` chain or a CI step while silently doing nothing, and the printed report is
// the only thing that says otherwise.
return result.completed ? 0 : NOT_COMPLETED;
}

function formatValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) return dim("(none)");
    if (value.every((v) => typeof v !== "object")) {
      return value.map((v) => String(v)).join(", ");
    }
    return `\n${value.map((v) => `    ${JSON.stringify(v)}`).join("\n")}`;
  }
  if (value === true) return green("yes");
  if (value === false) return red("no");
  return String(value);
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export const agentCommand = defineCommand("agent", {
    summary: "run and inspect the built-in agents",
    valueFlags: ["task", "session", "state-dir", "blackboard-dir", "project", "workspace", "log-file"],
    usage: `aflow agent [list]
    aflow agent show <id>
    aflow agent run <id> "<task>" [--session ID] [--workspace PATH] [--yes | --deny]

    list    the built-in agents and what each may do
    show    one agent's declaration: scopes, allowlist, gates, bounds, contracts
    run     execute an agent against a task

    --session ID          continue an existing session (adds its context)
    --workspace PATH      the only tree the tools may read or write
    --state-dir PATH      where sessions live
    --blackboard-dir PATH where the blackboard lives
    --project PATH        project root, for blackboard scoping
    --yes                 approve every gated tool action without asking
    --deny                refuse every gated tool action
    --json                machine-readable output

  Exit codes: 0 completed, 1 failed/timed out/cancelled, 2 usage.

  Every run gets a session, created for you if you did not name one, so the tool calls
  it made stay retrievable afterwards. Pass --session ID to continue an existing one.

  The workspace defaults to --project, then to the current directory, and is resolved
  to a physical path before anything runs. It is not negotiable from inside a run: a
  model that could choose its own root could choose a wider one.

  The built-in agents:

    planner      turn an objective into a checkable plan          read-only
    coder        implement a change and show evidence              writes, asks
    reviewer     judge a change against its intent                read-only
    debugger     find the actual cause, then fix that              writes, asks
    tester       prove it works, or prove exactly that it does not writes, asks
    researcher   answer from evidence, say how confident           read-only, network asks
    security     find the vulnerability that is actually there     read-only
    release      prepare and verify; publish only when told       asks about everything

  Approval is interactive on a terminal. Without one, gated actions are refused --
  run with --yes if you mean it.

  An agent's scopes decide what it may do. Its instructions do not. The model is the
  untrusted party, so "do not push" in a prompt is not a control and is not treated as
  one; a control is an entry in the allowlist.

  Examples
    aflow agent
    aflow agent show coder
    aflow agent run planner "add a health endpoint"
    aflow agent run coder "fix the null deref in routing.js" --workspace . --json

  Nothing is dispatched to a provider by list or show.`,
  run: async ({ args, flags, out, config }) => {
    const [sub = "list", ...rest] = args;
    try {
      // Awaited, not just returned. The subcommands are async, so a bare `return`
      // hands their rejections back to the caller and this catch never sees them --
      // a usage mistake exits 1 through the generic handler instead of 2 here.
      switch (sub) {
        case "list":
          return await listSub(out, flags);
        case "show":
        case "inspect":
          return await showSub(rest, out);
        case "run":
        case "exec":
          return await runSub(rest, flags, out, config);
        default:
          throw usage(`unknown subcommand: ${sub}\n\n${agentCommand.usage}`);
      }
    } catch (err) {
      if (err.usage) {
        await out.init({ error: err.message, usage: agentCommand.usage }, () => `${err.message}\n\n${agentCommand.usage}`);
        return USAGE_ERROR;
      }
      throw err;
    }
  },
});

export default agentCommand;
