// `aflow chat` -- the interactive chat loop.
//
// This is the thinnest possible shell around ChatSession (src/core/chat.js): the
// engine owns the conversation, streaming, persistence and failover; this file
// owns readline, ANSI, and the exit sequence. Keeping the split clean is what
// makes the engine unit-testable without a terminal and the terminal testable
// without a provider.
//
// Four behaviours are deliberate rather than incidental:
//
//  1. Streaming, not "wait then print". Tokens are written as they arrive, so a
//     slow model still feels alive. The engine hands each delta to `onToken`;
//     this file writes it straight through.
//
//  2. Ctrl+C cancels before it quits. The first press during a response aborts
//     the in-flight request (matched by the engine to `code: "cancelled"`) and
//     keeps the session; the second press, at the idle prompt, exits. A chat
//     that exits on the first Ctrl+C loses the exact response you wanted to
//     stop, which is the wrong default.
//
//  3. The prompt is only drawn for a TTY. When stdin is piped the loop runs the
//     same code path but prints no prompt, so `echo "hi" | aflow chat` produces
//     clean output -- and the same loop serves interactive and scripted use.
//
//  4. Nothing is dispatched by construction. `--help` and a bad agent id are
//     answered before any store or provider is touched.
//
// The command reads `ctx.deps` like `tribunal` does: production never passes it,
// tests use it to inject a mock stream and scripted stdin/stdout.

import process from "node:process";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineCommand } from "../cli/registry.js";
import { ChatSession, parseSlash } from "../core/chat.js";
import { SessionStore, defaultSessionsDir } from "../core/sessions.js";
import { BlackboardStore, defaultBlackboardDir } from "../core/blackboard.js";
import { ProviderHealth } from "../core/provider-health.js";
import { AgentRegistry } from "../core/agents/registry.js";
import { builtinSpecs } from "../core/agents/definitions.js";
import { resolveWorkspaceRoot } from "../core/agents/workspace.js";
import { listModels, ping } from "../core/gateway.js";
import { EventLog, defaultLogPath } from "../core/events.js";
import { executeTribunal } from "./tribunal.js";
import { bold, dim, red, green, yellow, cyan } from "../cli/ui.js";
import { fuzzyPick } from "../tui/interact.js";
import { buildModelItems, configuredProviders } from "../tui/model-picker.js";
import { pickFile } from "../tui/file-picker.js";
import { createApprover } from "../tui/approval.js";
import { runDiffViewer } from "../tui/diff-viewer-dialog.js";
import { parseGitDiff, renderUnifiedDiff } from "../tui/diff.js";
import { runTimeline } from "../tui/timeline-dialog.js";
import { buildTimeline, renderTimeline } from "../tui/timeline.js";

const USAGE_ERROR = 2;
const FAILURE = 1;
const execFileAsync = promisify(execFile);

/**
 * Resolve the streams the loop reads and writes.
 *
 * Injected by tests; process.stdin/stdout by production. `interactive` is a
 * separate decision from "is a stream a TTY" because a test may want the TTY
 * path without a real terminal.
 */
function resolveIO(deps) {
  const input = deps.input || process.stdin;
  const output = deps.output || process.stdout;
  const interactive = deps.interactive ?? Boolean(input?.isTTY && output?.isTTY);
  return { input, output, interactive };
}

/** Read a stream to a string. Used only for the piped `--json` one-shot. */
async function readAll(stream) {
  if (!stream || stream.isTTY) return "";
  let data = "";
  for await (const chunk of stream) data += chunk.toString();
  return data;
}

/**
 * Collect the workspace's uncommitted changes as viewer-ready file diffs.
 *
 * `git diff HEAD` covers staged and unstaged edits to tracked files. A file that
 * exists only on disk has no HEAD version and so does not appear -- noted as a
 * limitation rather than worked around with `git add -N`, which would mutate the
 * index from a read command. A missing `git`, a non-repository, or a failed
 * command all resolve to an empty list so the viewer opens on "(no file
 * changes)" instead of the chat loop throwing.
 *
 * @param {string} root
 * @returns {Promise<Array<{path:string, diff:Array<object>, additions:number, deletions:number}>>}
 */
async function workspaceDiffs(root) {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (!stdout || !stdout.trim()) return [];
    return parseGitDiff(stdout);
  } catch {
    return [];
  }
}

/**
 * Read the current session's persisted entries for the timeline viewer. The
 * engine keeps the session record (and its entry stream) in the store, so the
 * timeline reads it back rather than reconstructing from in-memory messages --
 * the entries carry tool calls, routing decisions and tribunal runs the message
 * array does not. A missing store or an unreadable record yields an empty list.
 *
 * @param {object} session
 * @returns {Array<object>}
 */
function readSessionEntries(session) {
  try {
    const id = session?.getInfo?.().sessionId;
    if (!id) return [];
    const store = session?.sessions;
    if (!store || typeof store.read !== "function") return [];
    const record = store.read(id);
    return Array.isArray(record?.entries) ? record.entries : [];
  } catch {
    return [];
  }
}

async function usage(out, message) {
  await out.init(
    { error: message, usage: chatCommand.usage },
    () => `${message}\n\n${chatCommand.usage}`,
  );
  return USAGE_ERROR;
}

/**
 * A compact health check for `/doctor`.
 *
 * Deliberately smaller than `aflow doctor`: inside a conversation the useful
 * question is "is the gateway up, and is my current provider degraded", not a
 * full catalogue sweep that would stall the prompt for seconds.
 */
async function doctorHandler(session, config) {
  const lines = [];
  /** @type {{ ok: boolean, elapsedMs?: number, error?: unknown }} */
  const result = await ping(config).catch((err) => ({ ok: false, error: err?.message || String(err) }));
  lines.push(
    result.ok ? green(`gateway reachable (${result.elapsedMs}ms)`) : red(`gateway unreachable: ${result.error}`),
  );
  const status = session.statusData();
  const record = status.provider ? session.health.getProviderStatus(status.provider) : null;
  lines.push(
    record
      ? `provider ${status.provider}: ${record.status} (circuit ${record.circuitState}, ${record.failureCount} failure(s))`
      : "provider: none selected",
  );
  lines.push(`model: ${status.model ?? "(none)"}${status.fallback ? " (fallback)" : ""}`);
  return lines.join("\n");
}

/**
 * Run the tribunal on a proposal from inside the chat.
 *
 * Reuses the same pipeline `aflow tribunal run` uses, with the session's own
 * completion as the model call, so no second gateway client is created.
 */
async function tribunalHandler(session, config, prompt) {
  const models = session.modelId ? [session.modelId] : [];
  const { result } = await executeTribunal({
    prompt,
    models,
    completeFn: (cfg, modelId, text, opts) => session.complete(cfg, modelId, text, opts),
    config,
  });
  const verdict = result?.oracle?.verdict ?? "UNKNOWN";
  const confidence =
    typeof result?.oracle?.confidence === "number" ? `${Math.round(result.oracle.confidence * 100)}%` : "n/a";
  const summary = result?.battle_report?.summary ?? "";
  return [`tribunal verdict: ${verdict} (${confidence})`, summary].filter(Boolean).join("\n");
}

function renderBanner(session, workspace) {
  const info = session.getInfo();
  const where = info.fresh ? "new" : "resumed";
  return [
    "",
    `${bold("aflow chat")} ${dim("·")} ${cyan(info.agentId)} ${dim("·")} ${info.model ?? dim("no model")} ${dim("·")} session ${info.sessionId} ${dim(`(${where})`)}`,
    dim(`workspace ${workspace.root} (${workspace.source})`),
    dim("type /help for commands, /quit to exit. Ctrl+C cancels a response."),
    "",
  ].join("\n");
}

function renderExit(session) {
  const info = session.getInfo();
  return [
    dim(`session ${info.sessionId} · ${info.messages} message(s) · ~${info.tokens} tokens`),
    dim(`resume: aflow chat --resume ${info.sessionId}`),
  ].join("\n");
}

/**
 * The readline loop.
 *
 * Lines are delivered through an explicit queue rather than `rl.question`. That
 * is not a stylistic choice: `question` only listens for the *next* line, so a
 * piped producer that writes two lines faster than the loop can ask drops the
 * second -- `printf "hi\n/quit\n" | aflow chat` would lose the `/quit`. A
 * persistent 'line' listener plus a queue loses nothing, and the `close`
 * handshake resolves a pending read on EOF so the loop cannot hang.
 */
async function conversationLoop(session, io, workspace) {
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: io.interactive });
  let closed = false;
  let waiter = null;
  let abort = null;
  const queue = [];

  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  });

  const nextLine = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };

  const prompt = (text) => {
    if (!io.interactive) return;
    rl.setPrompt(cyan(text));
    rl.prompt();
  };

  // Bind the permission waterfall to this terminal. A held continuation (a tool
  // call that may have run before a provider failed) and a gated tool both become
  // questions on the same line queue the loop already reads, so the prompt cannot
  // fight the reader. EOF yields null and the answer is no: fail closed.
  session.setApprover(
    createApprover({
      interactive: Boolean(io.interactive),
      input: io.input,
      output: io.output,
      readLine: nextLine,
      width: undefined,
      keyOf: (call) => call?.scope || call?.tool || "?",
    })
  );

  // Terminal Ctrl+C. First press aborts an in-flight response; a press at the
  // idle prompt closes the loop. rl owns SIGINT when terminal is true, so this
  // handler -- not process.on -- is what runs.
  rl.on("SIGINT", () => {
    if (abort) {
      abort.abort(new Error("interrupted by user"));
      io.output.write(`\n${yellow("[interrupted]")}\n`);
    } else {
      io.output.write("\n");
      rl.close();
    }
  });

  const sendTurn = async (message) => {
    abort = new AbortController();
    let started = false;
    const onToken = (token) => {
      if (!started) {
        started = true;
        io.output.write("\n");
      }
      io.output.write(token);
    };
    try {
      const result = await session.send(message, { onToken, signal: abort.signal });
      if (started) io.output.write("\n");
      if (result.ok) {
        if (result.info?.fallback) io.output.write(dim(`(answered by ${result.model})\n`));
      } else if (result.cancelled) {
        // Announced by the SIGINT handler; the engine keeps the user turn.
      } else if (result.error) {
        io.output.write(`${red(`error: ${result.error.message}`)}\n`);
      }
      return result;
    } finally {
      abort = null;
    }
  };

  const readBlock = async () => {
    prompt("> ");
    const first = await nextLine();
    if (first === null) return null;
    let text = first;
    // A trailing backslash continues onto the next line, the shell convention
    // people already reach for when pasting a multi-line prompt.
    while (text.endsWith("\\") && !closed) {
      prompt("... ");
      const more = await nextLine();
      if (more === null) break;
      text = `${text.slice(0, -1)}\n${more}`;
    }
    return text;
  };

  while (!closed) {
    const block = await readBlock();
    if (block === null) break;
    const text = block.trim();
    if (!text) continue;

    // A lone `@` opens the file picker over the workspace. Enter on a file adds
    // it to the prompt context through the existing `/add` command, so the picker
    // is a front-end for a capability the engine already has.
    if (text === "@" && io.interactive) {
      io.output.write("\n");
      const chosen = await pickFile({ root: workspace.root, input: io.input, output: io.output });
      if (chosen) {
        const result = await session.command({ name: "add", arg: chosen });
        if (result.text) io.output.write(`${result.text}\n`);
      }
      continue;
    }

    const parsed = parseSlash(text);
    if (parsed) {
      // `/model` with no argument is an invitation to pick, not a status line.
      // On a TTY we open the fuzzy picker over the provider catalogue; when a
      // model is chosen it is applied through the same engine command the user
      // would have typed. Non-interactive input keeps the plain status text.
      if (parsed.name === "model" && !parsed.arg && io.interactive) {
        const items = buildModelItems({
          configured: configuredProviders(),
          currentModel: session.modelId,
        });
        if (items.length) {
          io.output.write("\n");
          const choice = await fuzzyPick(items, { title: "Select model", max: 14, width: 72, input: io.input, output: io.output });
          if (choice) {
            const result = await session.command({ name: "model", arg: choice });
            if (result.text) io.output.write(`${result.text}\n`);
          }
          continue;
        }
      }
      // `/diff` is answered here rather than in the engine: it needs a terminal
      // (for the viewer's raw keypresses) or a shell (for git), neither of which
      // belongs in ChatSession. On a TTY it opens the interactive viewer over the
      // workspace's uncommitted changes; piped input gets the same diff as plain
      // text so `aflow chat` in a script is not a dead end.
      if (parsed.name === "diff") {
        const files = await workspaceDiffs(workspace.root);
        if (files.length === 0) {
          io.output.write(`${dim("(no changes to show)")}\n`);
          continue;
        }
        if (io.interactive) {
          const idx = parsed.arg ? files.findIndex((f) => f.path === parsed.arg) : 0;
          io.output.write("\n");
          await runDiffViewer(files, {
            input: io.input,
            output: io.output,
            width: Math.max(40, Math.min(110, (io.output.columns || 80) - 1)),
            height: Math.max(12, Math.min(40, (io.output.rows || 24) - 6)),
            fileIndex: idx >= 0 ? idx : 0,
          });
          continue;
        }
        const parts = files.map((f) => renderUnifiedDiff(f.path, f.diff, { width: io.output.columns || 80 }));
        io.output.write(`${parts.join("\n\n")}\n`);
        continue;
      }
      // `/timeline` renders the session's append-only entry stream as a
      // navigable list. Like `/diff` it is answered here: the viewer needs raw
      // keypresses on a TTY, and non-interactive input gets the same list as
      // plain text so scripts are not a dead end.
      if (parsed.name === "timeline") {
        const entries = readSessionEntries(session);
        if (entries.length === 0) {
          io.output.write(`${dim("(no timeline entries)")}\n`);
          continue;
        }
        if (io.interactive) {
          io.output.write("\n");
          await runTimeline(entries, {
            input: io.input,
            output: io.output,
            width: Math.max(40, Math.min(120, (io.output.columns || 80) - 1)),
            height: Math.max(12, Math.min(40, (io.output.rows || 24) - 6)),
          });
        } else {
          io.output.write(`${renderTimeline(buildTimeline(entries), { width: io.output.columns || 80 })}\n`);
        }
        continue;
      }
      const result = await session.command(parsed);
      if (result.exit) break;
      if (result.text) io.output.write(`${result.text}\n`);
      continue;
    }

    await sendTurn(text);
  }

  session.setApprover(null);
  rl.close();
  return 0;
}

/**
 * The command body, factored out so tests can drive it with injected deps.
 *
 * @param {{ args?: string[], flags?: Record<string, unknown>, config?: object, out: object, deps?: object }} ctx
 */
export async function runChat({ args = [], flags = {}, config = {}, out, deps = {} }) {
  const io = resolveIO(deps);

  // Validated before any store is opened or any model is named: a bad agent id
  // or a contradictory flag set is a usage answer, not a half-started session.
  const agentId = flags.agent ? String(flags.agent) : "coder";
  const registry = deps.registry || new AgentRegistry(builtinSpecs());
  try {
    registry.get(agentId);
  } catch {
    return usage(out, `unknown agent: ${agentId}`);
  }

  const resumeId = flags.resume ? String(flags.resume) : null;
  const forceNew = flags.new === true || flags.new === "true";
  if (resumeId && forceNew) return usage(out, "choose one: --resume <id> or --new");

  const workspace = resolveWorkspaceRoot({
    explicit: flags.workspace ? String(flags.workspace) : flags.project ? String(flags.project) : null,
    projectRoot: flags.project ? String(flags.project) : null,
    cwd: process.cwd(),
  });

  const sessions =
    deps.sessions || new SessionStore({ dir: flags["state-dir"] ? String(flags["state-dir"]) : defaultSessionsDir() });
  const blackboard =
    deps.blackboard ||
    new BlackboardStore({
      dir: flags["blackboard-dir"] ? String(flags["blackboard-dir"]) : defaultBlackboardDir(),
      projectRoot: workspace.root,
    });

  // Created on first use so the project digest in the system prompt has
  // something to read. Best-effort: a read-only checkout must still chat.
  if (typeof blackboard.exists === "function" && !blackboard.exists()) {
    try {
      blackboard.create({ goal: "interactive chat", objective: `chat in ${workspace.root}` });
    } catch {
      /* best-effort context, not a hard requirement */
    }
  }

  const log =
    deps.log || new EventLog({ file: flags["log-file"] || config.logPath || defaultLogPath(), level: config.logLevel });
  const health = deps.health || new ProviderHealth({});

  let catalogue = [];
  try {
    const all = await (deps.listModels || listModels)(config);
    catalogue = (Array.isArray(all) ? all : [])
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    /* a down gateway is not a reason to refuse to chat */
  }

  const session = new ChatSession({
    sessions,
    blackboard,
    config,
    agentId,
    modelId: flags.model ? String(flags.model) : null,
    registry,
    health,
    log,
    stream: deps.stream ?? null,
    complete: deps.complete ?? null,
    now: deps.now,
    workspaceRoot: workspace.root,
    projectRoot: workspace.root,
    catalogue,
  });

  try {
    await session.init({ resumeId, forceNew });
  } catch (err) {
    if (out.json) {
      await out.init({ error: err?.message || String(err), code: err?.code ?? null }, () => "");
    } else {
      out.error(`chat: ${err?.message || err}`);
    }
    return FAILURE;
  }

  session.handlers = {
    tribunal: (prompt) => tribunalHandler(session, config, prompt),
    doctor: () => doctorHandler(session, config),
  };

  // `--json` is a one-shot: one message in, one JSON object out. Streaming into
  // stdout would corrupt the payload, so the engine's full-text path is used.
  if (out.json) {
    const inline = args.join(" ").trim() || (typeof flags.message === "string" ? flags.message.trim() : "");
    const message = inline || (await readAll(io.input)).trim();

    if (!message) {
      await out.init({ session: session.getInfo(), messages: session.getHistory() }, (r) => JSON.stringify(r, null, 2));
      await session.close();
      return 0;
    }

    const result = await session.send(message);
    const payload = {
      ok: result.ok,
      sessionId: session.getInfo().sessionId,
      model: result.model ?? session.modelId ?? null,
      provider: result.provider ?? null,
      text: result.text ?? null,
      error: result.error ? result.error.message : null,
    };
    await out.init(payload, (r) => r.text ?? "");
    await session.close();
    return result.ok ? 0 : FAILURE;
  }

  if (io.interactive) out.info(renderBanner(session, workspace));

  const code = await conversationLoop(session, io, workspace);

  await session.close();
  if (io.interactive) out.info(renderExit(session));
  return code;
}

export const chatCommand = defineCommand("chat", {
  summary: "interactive chat with streaming, sessions, and provider failover",
  valueFlags: [
    "resume",
    "model",
    "agent",
    "project",
    "workspace",
    "state-dir",
    "blackboard-dir",
    "log-file",
    "message",
  ],
  usage: `aflow chat [options]
  aflow chat "<message>"            one-shot: send one message and exit
  aflow chat --json "<message>"     one-shot, machine-readable output

  aflow chat                        resume this project's session, or start one
  aflow chat --new                  force a fresh session
  aflow chat --resume <id>          resume a specific session
  aflow chat --model <id>           start on a specific model
  aflow chat --agent <id>           use an agent's identity (default coder)
  aflow chat --project <dir>        scope the session and tools to a directory

  Slash commands (interactive):
    /help                show the command list
    /quit, /exit         save and exit
    /model [id]          show or switch the model
    /session             current session details
    /sessions            list recent sessions
    /new                 start a new session (saves the current one)
    /clear               clear the in-memory prompt (keeps the session)
    /compact             summarise and compress the conversation
    /tribunal <prompt>   run the five-stage tribunal on a proposal
    /agent <task>        run a bounded, tool-using agent task
    /doctor              gateway and provider health check
    /status              provider health and current tier
    /add <file>          add a file to the context
    /drop <file>         remove a file from the context
    /context             show what is in the prompt's context
    /diff [file]         open the diff viewer over workspace changes
    /timeline            browse this session's entry stream

  Responses stream token by token. Ctrl+C cancels the current response;
  Ctrl+C again, or Ctrl+D (EOF), exits. Every exchange is saved to the
  session store, so --resume continues exactly where you left off.

  Failover is automatic: when a model fails or returns empty, the next
  candidate answers and the switch is recorded. The user never retypes.

  Exit codes: 0 ok, 1 a one-shot message failed, 2 usage.`,
  run: async ({ args = [], flags = {}, config = {}, out, deps = {} }) => runChat({ args, flags, config, out, deps }),
});

export default chatCommand;
