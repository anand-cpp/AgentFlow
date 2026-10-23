// Interactive chat session engine.
//
// `aflow chat` turns a one-shot CLI into a persistent coding companion. This
// module is the engine behind it: it owns the conversation, streams tokens from
// the gateway, persists every exchange to the SessionStore, and moves the
// conversation to another provider when one fails. It renders nothing and reads
// no keyboard -- the CLI command (src/commands/chat.js) owns readline and ANSI,
// and this module stays a plain, injectable, testable object.
//
// The design answers four questions the CLI cannot answer for itself:
//
//  1. Conversation model. The live context is an in-memory array of
//     `{ role, content }` messages, rebuilt on resume by replaying the session's
//     `conversation` entries. The whole array is sent each turn; the model is
//     stateless and the context is reconstructed client-side, which is the only
//     shape that lets a resumed session, a switched provider, and a fresh process
//     all see the same conversation.
//
//  2. Context window management. A rolling buffer. When the estimated size passes
//     `contextBudgetChars` -- or on `/compact` -- the oldest messages are replaced
//     by a model-written summary, kept as a compaction note that rides in the
//     system prompt. If summarisation is unavailable the same boundary is drawn
//     with a truncation marker, because silently dropping history without saying
//     so is the one outcome worse than a lossy summary.
//
//  3. Session lifecycle. With no arguments, chat resumes the store's *current*
//     session for this project if one exists, and creates a fresh one otherwise;
//     `--resume <id>` and `--new` override that. Every exchange auto-saves.
//
//  4. Failover. Completion runs through the Router, so the candidate order, the
//     per-model health cache and the provider-level circuit breaker all apply
//     exactly as they do for an agent run. The user never retypes: the pending
//     message is already in the conversation before dispatch, and a mid-response
//     failure is announced rather than silently restitched.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";

import { ROLE, complete as gatewayComplete, streamComplete as gatewayStream } from "./gateway.js";
import { Router, tiersFromList, parseModelId } from "./routing.js";
import { orderByCost } from "./model-cost.js";
import { ProviderHealth, PROVIDER_STATUS } from "./provider-health.js";
import { UsageLedger } from "./usage-ledger.js";
import { ENTRY_KIND } from "./sessions.js";
import { AgentRegistry } from "./agents/registry.js";
import { builtinSpecs } from "./agents/definitions.js";
import { AgentRuntime } from "./agents/runtime.js";
import { createRealTools } from "./agents/real-tools.js";
import { createRepoMapBridge } from "./map/agent-bridge.js";
import { PluginManager, PLUGIN_PROMPT_TOKEN_BUDGET } from "./plugins/manager.js";
import { VERSION } from "./version.js";
import { EVENTS } from "./events.js";

const DEFAULT_CONTEXT_BUDGET_CHARS = 24_000;
const DEFAULT_RECENT_KEEP = 6;
const MAX_CONTEXT_FILE_CHARS = 8_000;
const APPROX_CHARS_PER_TOKEN = 4;

export class ChatError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = "chat_error") {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

/**
 * Parse a slash command line.
 *
 * Pure and total: anything that is not a slash command returns null, so the CLI
 * can hand every line to it and fall through to "this is a message" without a
 * special case. The split is on the first whitespace, which keeps `/add a b.js`
 * from being read as a command named "add a".
 *
 * @param {string} input
 * @returns {{ name: string, arg: string, raw: string } | null}
 */
export function parseSlash(input) {
  const text = String(input ?? "").trim();
  if (!text.startsWith("/")) return null;
  const space = text.search(/\s/);
  const rawName = space === -1 ? text.slice(1) : text.slice(1, space);
  const name = rawName.toLowerCase().trim();
  const arg = space === -1 ? "" : text.slice(space + 1).trim();
  if (!name) return null;
  return { name, arg, raw: text };
}

/** Resolve a slash alias to its canonical command name. */
export function canonicalCommand(name) {
  const n = String(name || "").toLowerCase();
  if (n === "exit") return "quit";
  if (n === "q") return "quit";
  return n;
}

export const SLASH_HELP = [
  "chat commands:",
  "  /help                show this help",
  "  /quit, /exit         save the session and exit",
  "  /model [id]          show or switch the model",
  "  /session             current session details",
  "  /sessions            list recent sessions",
  "  /new                 start a new session (saves the current one first)",
  "  /clear               clear in-memory history (keeps the session)",
  "  /compact             summarise and compress the conversation",
  "  /tribunal <prompt>   run the tribunal on the current topic",
  "  /agent <task>        run a bounded, tool-using agent task",
  "  /doctor              quick gateway and provider health check",
  "  /status              provider health and current tier",
  "  /add <file>          add a file to the context",
  "  @                    open the file picker to add a file to context",
  "  /drop <file>         remove a file from the context",
  "  /context             show what is in the current context",
  "  /diff [file]         open the interactive diff viewer over workspace changes",
  "  /timeline            browse this session's entry stream",
  "  /swarm               draw this session's agent handoff graph",
  "  /git [sub]           repository status, log, diff, branch, stage, commit, stash",
  "  /lsp [sub]           language-server status, diagnostics, hover, definition",
  "  /mcp [sub]           MCP servers: status, tools, call, read",
  "  /map [sub]           repository map: show, build, query, stats",
  "  /plugin [sub]        plugins: list, inspect, enable, disable, create",
  "",
  "Anything without a leading / is sent to the model.",
].join("\n");

/**
 * Command names plugins may not register. Everything documented above plus
 * every switch arm in `command()`: a plugin command that shadowed /quit or
 * /new would be a session-control takeover, not an extension.
 */
export const RESERVED_COMMANDS = Object.freeze([
  "help", "quit", "exit", "q", "model", "session", "sessions", "new", "clear",
  "compact", "tribunal", "agent", "doctor", "status", "add", "drop", "context",
  "diff", "timeline", "swarm", "git", "lsp", "mcp", "map", "blackboard",
  "plugin",
]);

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function approxTokens(text) {
  return Math.ceil(String(text ?? "").length / APPROX_CHARS_PER_TOKEN);
}

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const total = usage.total_tokens ?? (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0));
  return Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
}

/**
 * A persistent, streamed chat over the existing infrastructure.
 *
 * Every collaborator is injectable so the engine is testable without a gateway,
 * a terminal, or a disk: `stream`/`complete` default to the gateway module,
 * `sessions`/`blackboard` to the caller's stores, `health` to a fresh
 * ProviderHealth, and `registry` to the built-in agents.
 */
export class ChatSession {
  /**
   * @param {{
   *   sessions?: object|null, blackboard?: object|null, gateway?: object|null,
   *   router?: object|null, health?: object|null, config?: object, agentId?: string,
   *   modelId?: string|null, log?: object|null, registry?: object|null,
   *   stream?: Function|null, complete?: Function|null, now?: () => number,
   *   contextBudgetChars?: number, recentKeep?: number, workspaceRoot?: object|string|null,
   *   projectRoot?: string|null, catalogue?: string[], handlers?: object,
   *   approver?: Function|null, pluginManager?: object|null, limiter?: object|null,
   *   usage?: object|null
   * }} [options]
   */
  constructor({
    sessions = null,
    blackboard = null,
    gateway = null,
    router = null,
    health = null,
    config = {},
    agentId = "coder",
    modelId = null,
    log = null,
    registry = null,
    stream = null,
    complete = null,
    now = () => Date.now(),
    contextBudgetChars = DEFAULT_CONTEXT_BUDGET_CHARS,
    recentKeep = DEFAULT_RECENT_KEEP,
    workspaceRoot = null,
    projectRoot = null,
    catalogue = [],
    handlers = {},
    approver = null,
    pluginManager = null,
    limiter = null,
    usage = null,
  } = {}) {
    const gw = gateway || { complete: gatewayComplete, streamComplete: gatewayStream };

    this.sessions = sessions;
    this.blackboard = blackboard;
    this.gateway = gw;
    this.health = health || new ProviderHealth({ now });
    this.router = router || null;
    this.limiter = limiter;
    this.usage = usage || new UsageLedger({ now });
    this._usagePersisted = 0;
    this.config = config || {};
    // Validated once here so a malformed `modelHints` value cannot throw inside
    // routing, and so the chat runtime sees the same hints as the candidate list.
    this.hints =
      this.config.modelHints && typeof this.config.modelHints === "object" && !Array.isArray(this.config.modelHints)
        ? this.config.modelHints
        : {};
    this.agentId = agentId;
    this.modelId = modelId || this.config.defaultModel || null;
    this.log = log;
    this.now = now;
    this.registry = registry || new AgentRegistry(builtinSpecs());
    this.stream = stream || ((cfg, model, messages, opts) => gw.streamComplete(cfg, model, messages, opts));
    this.complete = complete || gw.complete;
    this.contextBudgetChars = contextBudgetChars;
    this.recentKeep = recentKeep;
    this.catalogue = Array.isArray(catalogue) ? catalogue : [];
    this.handlers = handlers || {};
    // Plugins: injected manager wins; otherwise one is created (and loaded)
    // during init(). A null stays null when plugins are disabled.
    this.pluginManager = pluginManager || null;
    // The permission waterfall the agent runtime uses for tool (and continuation)
    // approvals. The CLI binds it once a terminal is available; unset means the
    // runtime fails closed, which is the correct default for --json and pipes.
    this.approver = typeof approver === "function" ? approver : null;

    this.projectRoot = projectRoot ? path.resolve(String(projectRoot)) : null;
    this.workspaceRoot = workspaceRoot
      ? typeof workspaceRoot === "string"
        ? path.resolve(workspaceRoot)
        : String(workspaceRoot.root || workspaceRoot)
      : null;

    /** @type {Array<{ role: string, content: string }>} */
    this.messages = [];
    this.tokens = 0;
    /** @type {Array<{ path: string, content: string }>} */
    this.contextFiles = [];
    this.compactionNote = null;

    this.session = null;
    this.agent = null;
    this.runtime = null;
    this.currentProvider = this.modelId ? parseModelId(this.modelId).provider : null;
    this.fallback = false;
    this.fresh = true;
    this.primaryModel = null;
  }

  /**
   * Start or resume a session.
   *
   * Resuming is the default because the feature exists to be a persistent
   * companion, but it is never silent: a resumed session's id and age come back
   * in getInfo(), and the CLI prints "(resumed)" beside it.
   *
   * @param {{ resumeId?: string|null, forceNew?: boolean }} [opts]
   */
  async init({ resumeId = null, forceNew = false } = {}) {
    if (!this.sessions) throw new ChatError("chat requires a session store", "no_sessions");

    let session = null;
    if (resumeId) {
      session = this.sessions.read(resumeId); // throws SessionNotFoundError for an unknown id
    } else if (!forceNew) {
      const current = typeof this.sessions.getCurrent === "function" ? this.sessions.getCurrent() : null;
      if (current) {
        try {
          session = this.sessions.read(current);
        } catch {
          session = null;
        }
        // Only resume the pointer when it is this project's session; resuming a
        // session from an unrelated tree would pour another project's history
        // into this conversation.
        if (session && this.projectRoot && session.project?.root && session.project.root !== this.projectRoot) {
          session = null;
        }
      }
    }

    if (!session) {
      session = this.createSession();
      this.fresh = true;
    } else {
      this.fresh = false;
    }

    this.session = session;
    this.#resolveAgent();
    if (!this.modelId && session.model) this.modelId = session.model;
    if (!this.modelId) {
      this.modelId =
        this.agent?.model?.pinModel ||
        this.agent?.model?.prefer?.[0] ||
        this.config.defaultModel ||
        null;
    }
    this.primaryModel = this.modelId;
    this.currentProvider = this.modelId ? parseModelId(this.modelId).provider : null;

    this.#replay(session);
    if (typeof this.sessions.setCurrent === "function") this.sessions.setCurrent(session.id);
    this.#emit(EVENTS.SESSION_START, { sessionId: session.id, agentId: this.agentId, model: this.modelId });
    // Plugins load once, before the runtime exists: their tools walk into the
    // runtime's tool map through the same door builtins use, and their
    // providers wrap the dispatch pair below. A plugin flood gate that fails
    // costs the manager registry entries, never the session.
    await this.#initPlugins();
    this.#buildRuntime();
    return this;
  }

  /** Create (and persist) a fresh session for this project. */
  createSession() {
    return this.sessions.create({
      objective: null,
      projectRoot: this.projectRoot,
      agents: [this.agentId],
      provider: this.modelId ? parseModelId(this.modelId).provider : null,
      model: this.modelId,
    });
  }

  #resolveAgent() {
    try {
      this.agent = this.registry.get(this.agentId);
    } catch {
      this.agent = null;
    }
  }

  #buildRuntime() {
    try {
      this.runtime = new AgentRuntime({
        registry: this.registry,
        tools: createRealTools(),
        complete: (cfg, modelId, prompt, opts) => this.complete(cfg, modelId, prompt, opts),
        catalogue: this.catalogue,
        hints: this.hints,
        log: this.log,
        config: this.config,
        providerHealth: this.health,
        limiter: this.limiter,
        usageLedger: this.usage,
        blackboard: this.blackboard,
        sessions: this.sessions,
        workspaceRoot: this.workspaceRoot,
        approver: this.approver,
        plugins: this.pluginManager ?? null,
      });
      // The repository map rides on the runtime as one more tool, exactly the
      // way MCP tools do, and is injected into run context by runAgent(). A
      // bridge that fails to build loses the map, not the runtime.
      this.mapBridge = createRepoMapBridge(this.workspaceRoot, this.config);
      if (this.mapBridge) this.mapBridge.registerTools(this.runtime);
      // Plugin tools join the same map after the builtins, namespaced, so a
      // rebuilt runtime (setApprover) keeps them attached without re-loading
      // plugin code.
      if (this.pluginManager && this.runtime) this.pluginManager.registerToolsInto(this.runtime);
    } catch {
      this.runtime = null;
    }
  }

  /**
   * Create and load the plugin manager. Never throws: disabled config or a
   * load failure leaves `pluginManager` null, and the chat engine is exactly
   * the behaviour it would be without the directory.
   */
  async #initPlugins() {
    if (this.pluginManager) {
      // Rebuild path (setApprover): reattach tools to the fresh runtime.
      if (this.runtime) this.pluginManager.registerToolsInto(this.runtime);
      return;
    }
    if (this.config?.pluginsEnabled === false) return;
    try {
      const manager = new PluginManager({
        workspaceRoot: this.workspaceRoot ?? this.projectRoot ?? process.cwd(),
        currentVersion: VERSION,
        builtinCommands: RESERVED_COMMANDS,
        promptTokenBudget: PLUGIN_PROMPT_TOKEN_BUDGET,
      });
      await manager.init();
      this.pluginManager = manager;
      if (manager.providers.size > 0) {
        // Only plugin providers dispatch differently. The wrapper captures the
        // stream/complete pair as it is right now, including any test double,
        // and inlines no behaviour beyond the provider prefix check.
        const base = { complete: this.complete, streamComplete: this.stream };
        const dispatched = manager.providerDispatch(base);
        if (dispatched) {
          this.complete = dispatched.complete;
          // The dispatch wrapper names it `streamComplete`, matching the base
          // object it wraps. Reading `.stream` here silently installed
          // `undefined`, so every streamed reply threw as soon as a plugin
          // registered a provider.
          this.stream = dispatched.streamComplete;
        }
      }
      if (this.runtime) manager.registerToolsInto(this.runtime);
    } catch {
      // Discovery or load blew up outside the loader's per-plugin isolation.
      // The chat engine has no plugins at all rather than a half-built one.
      this.pluginManager = null;
    }
  }

  /** Rebuild the in-memory conversation from a session's persisted entries. */
  #replay(session) {
    this.messages = [];
    this.tokens = 0;
    const entries = Array.isArray(session?.entries) ? session.entries : [];
    for (const entry of entries) {
      if (entry?.kind !== ENTRY_KIND.CONVERSATION) continue;
      const role = entry.role === ROLE.ASSISTANT ? ROLE.ASSISTANT : ROLE.USER;
      if (typeof entry.content !== "string") continue;
      this.messages.push({ role, content: entry.content });
      this.tokens += usageTokens(entry.usage) || approxTokens(entry.content);
    }
  }

  /** The conversation so far, as a copy. */
  getHistory() {
    return this.messages.map((m) => ({ ...m }));
  }

  /** Current session metadata. */
  getInfo() {
    return {
      sessionId: this.session?.id ?? null,
      agentId: this.agentId,
      model: this.modelId,
      provider: this.currentProvider || (this.modelId ? parseModelId(this.modelId).provider : null),
      messages: this.messages.length,
      tokens: this.tokens,
      fresh: this.fresh,
      fallback: this.fallback,
      contextFiles: this.contextFiles.map((f) => f.path),
    };
  }

  /** The system prompt: agent identity plus live project context. */
  systemPrompt() {
    const parts = [];
    parts.push(
      this.agent?.instructions ||
        "You are AgentFlow, a terminal-first coding assistant. Be concise, precise, and honest about uncertainty.",
    );
    parts.push("", "--- project context ---");
    parts.push(`working directory: ${this.workspaceRoot || this.projectRoot || process.cwd()}`);

    const digest = this.#blackboardDigest();
    if (digest) parts.push("", digest);

    if (this.contextFiles.length) {
      parts.push("", "--- files in context ---");
      for (const file of this.contextFiles) parts.push(`### ${file.path}`, file.content);
    }
    if (this.compactionNote) parts.push("", this.compactionNote);
    return parts.join("\n");
  }

  #blackboardDigest() {
    if (!this.blackboard || typeof this.blackboard.exists !== "function" || !this.blackboard.exists()) return null;
    let s;
    try {
      s = this.blackboard.summary();
    } catch {
      return null;
    }
    const lines = ["--- blackboard ---"];
    if (s.goal) lines.push(`goal: ${truncate(s.goal, 200)}`);
    if (s.objective) lines.push(`objective: ${truncate(s.objective, 200)}`);
    if (s.nextAction?.text) lines.push(`next: ${truncate(s.nextAction.text, 200)}`);
    const names = (list, pick) => (Array.isArray(list) ? list.slice(0, 5).map((x) => truncate(pick(x) || x.id || "", 80)).join("; ") : "");
    if (s.inProgress?.length) lines.push(`in progress: ${names(s.inProgress, (t) => t.title)}`);
    if (s.openTasks?.length) lines.push(`open tasks: ${names(s.openTasks, (t) => t.title)}`);
    if (s.openBugs?.length) lines.push(`open bugs: ${names(s.openBugs, (b) => b.title)}`);
    if (s.openQuestions?.length) lines.push(`open questions: ${names(s.openQuestions, (q) => q.question)}`);
    if (s.activeDecisions?.length) lines.push(`decisions: ${names(s.activeDecisions, (d) => d.title || d.summary)}`);
    return lines.length > 1 ? lines.join("\n") : null;
  }

  #wireMessages() {
    return this.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  #estimatedChars() {
    let total = this.systemPrompt().length;
    for (const m of this.messages) total += m.content.length;
    for (const f of this.contextFiles) total += f.content.length;
    return total;
  }

  /**
   * The ordered candidate models: the chosen one first, then the agent's
   * preferences, then the catalogue ordered free-first.
   *
   * An explicit model, a pin, or an agent preference is intent and is never
   * re-ordered. Only the anonymous remainder is subject to the cost policy, so
   * enabling free-first cannot override a choice the user actually made.
   */
  #candidates() {
    const list = [];
    const push = (m) => {
      const id = typeof m === "string" ? m.trim() : "";
      if (id && !list.includes(id)) list.push(id);
    };
    push(this.modelId);
    if (this.agent?.model?.pinModel) push(this.agent.model.pinModel);
    for (const m of this.agent?.model?.prefer || []) push(m.prefer ? m.prefer : m);
    for (const id of orderByCost(this.catalogue, {
      hints: this.hints,
      catalogue: this.catalogue,
      preferFree: this.config?.preferFree !== false,
      allowPaid: this.config?.allowPaidFallback === true,
    })) {
      push(id);
    }
    push(this.config.defaultModel);
    return list;
  }

  /**
   * Send a user message and stream the response.
   *
   * The user turn is recorded *before* dispatch, so a provider cascade that
   * fails still leaves the message in the session -- the whole point of
   * `--resume` is that nothing the user typed is lost to a bad provider.
   *
   * @param {string} message
   * @param {{ onToken?: Function|null, onComplete?: Function|null, onError?: Function|null, onNotice?: Function|null, signal?: AbortSignal|null }} [opts]
   */
  async send(message, { onToken = null, onComplete = null, onError = null, onNotice = null, signal = null } = {}) {
    const text = typeof message === "string" ? message : String(message ?? "");
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty" };

    if (this.#estimatedChars() > this.contextBudgetChars) {
      await this.compact({ onNotice });
    }

    this.messages.push({ role: ROLE.USER, content: trimmed });
    this.#record(ROLE.USER, trimmed);

    const candidates = this.#candidates();
    if (!candidates.length) {
      const err = new ChatError(
        this.config?.allowPaidFallback === true
          ? "no model configured; pass --model or set defaultModel"
          : "no eligible model: paid fallback is disabled and no free, free-tier, unknown-cost, or explicitly named model is available (set allowPaidFallback: true to permit paid fallback)",
        "no_model"
      );
      onError?.(err);
      return { ok: false, error: err, reason: "no_model" };
    }

    const wire = this.#wireMessages();
    let sawNotice = false;
    const execute = async (modelId, { signal: s }) => {
      let emitted = 0;
      try {
        return await this.stream(this.config, modelId, wire, {
          signal: s,
          onToken: (tok) => {
            emitted += tok.length;
            onToken?.(tok);
          },
          timeoutMs: this.agent?.bounds?.timeoutMs,
          maxTokens: this.agent?.model?.maxTokens,
          temperature: this.agent?.model?.temperature,
          system: this.systemPrompt(),
        });
      } catch (err) {
        if (emitted > 0 && !s?.aborted && onNotice) {
          onNotice(`\n[${modelId} failed mid-response (${err?.message || err}); continuing with the next candidate]\n`);
          sawNotice = true;
        }
        throw err;
      }
    };

    const router =
      this.router ||
      new Router({
        tiers: tiersFromList(candidates, { size: 1 }),
        execute,
        log: this.log,
        now: this.now,
        providerHealth: this.health,
        limiter: this.limiter,
        limiterWaitMs: this.config?.maxRateLimitWaitMs,
        ledger: this.usage,
      });

    let receipt = await router.route({
      signal,
      onAttempt: (record) => this.#emit(EVENTS.ROUTE_ATTEMPT, record, record.outcome === "ok" ? "info" : "warn"),
    });

    // An empty completion (HTTP 200, no content) is the signature failure of free
    // tiers, and the router already treats it as retryable across candidates. If
    // every candidate answered empty, one explicit re-try is worth it before
    // giving up -- the provider may simply have been cold.
    if (!receipt.ok && !signal?.aborted && isOnlyEmpty(receipt.failureKinds)) {
      receipt = await router.route({ signal });
    }

    if (receipt.ok) {
      const value = receipt.value ?? {};
      const responseText = typeof value === "string" ? value : value.text ?? "";
      const model = receipt.model || value.model || this.modelId;
      const provider = receipt.provider || parseModelId(model).provider;
      this.fallback = Boolean(this.primaryModel) && model !== this.primaryModel;
      this.modelId = model;
      this.currentProvider = provider;

      this.messages.push({ role: ROLE.ASSISTANT, content: responseText });
      this.#record(ROLE.ASSISTANT, responseText, { model, provider, usage: value.usage ?? null });
      this.tokens += usageTokens(value.usage) || approxTokens(responseText);
      this.#updateHeader(provider, model);
      if (this.fallback) {
        this.#recordTransition({ from: this.primaryModel, to: model, failureClass: receipt.attempts?.find((a) => a.outcome !== "ok")?.outcome || null, reason: "failover" });
      }
      if (typeof this.sessions.setCurrent === "function") this.sessions.setCurrent(this.session.id);

      if (!responseText.trim()) {
        onNotice?.("[empty response from the model]");
      }
      const info = this.getInfo();
      this.#persistUsage();
      onComplete?.(responseText, info);
      return { ok: true, text: responseText, model, provider, usage: value.usage ?? null, usageSummary: this.usage.summary(), info, noticed: sawNotice };
    }

    if (signal?.aborted) {
      this.#persistUsage();
      return { ok: false, cancelled: true, reason: "cancelled" };
    }

    const err = receipt.error || new ChatError("all providers unavailable", "all_failed");
    err.failureKinds = receipt.failureKinds;
    err.attempts = receipt.attempts;
    this.#recordError(err.message);
    this.#persistUsage();
    onError?.(err);
    return {
      ok: false,
      error: err,
      reason: "all_failed",
      allFailed: true,
      failureKinds: receipt.failureKinds,
      attempts: receipt.attempts,
      usageSummary: this.usage.summary(),
    };
  }

  /**
   * Compress the conversation: replace the oldest messages with a summary.
   *
   * `force` is what `/compact` uses; without it, compaction only happens when the
   * buffer is over budget and there is something older than the recent window to
   * compress. The summary is written by the model when one is reachable, and by
   * truncation otherwise -- never by dropping history without a marker.
   */
  async compact({ force = false, onNotice = null } = {}) {
    if (this.messages.length <= this.recentKeep) return { compacted: false, removed: 0, summary: null };
    if (!force && this.#estimatedChars() <= this.contextBudgetChars) {
      return { compacted: false, removed: 0, summary: null };
    }

    const cut = this.messages.length - this.recentKeep;
    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);

    let summary = null;
    if (this.modelId) summary = await this.#summarize(older);
    if (!summary) {
      summary = older.map((m) => `${m.role}: ${truncate(m.content, 200)}`).join("\n");
    }

    this.compactionNote = `[earlier conversation summarized]\n${summary}`;
    this.messages = recent;
    this.#recordNote(`compacted ${older.length} earlier message(s)`);
    onNotice?.(`compacted ${older.length} earlier message(s)`);
    return { compacted: true, removed: older.length, summary };
  }

  async #summarize(older) {
    const transcript = older.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    const prompt =
      "Summarize this conversation for another assistant that will continue it. " +
      "Preserve decisions, file paths, identifiers, open questions and next steps. " +
      "Be concise. Reply with the summary only.\n\n---\n" +
      transcript;
    try {
      const res = await this.complete(this.config, this.modelId, prompt, {
        system: "You compress conversation history without losing operational detail.",
        timeoutMs: this.agent?.bounds?.timeoutMs ?? 30_000,
        maxTokens: 512,
      });
      const text = typeof res === "string" ? res : res?.text ?? "";
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  /** Persist and confirm current state. */
  async save() {
    if (!this.session) return null;
    if (typeof this.sessions.setCurrent === "function") this.sessions.setCurrent(this.session.id);
    return this.getInfo();
  }

  /** Clean shutdown. */
  async close() {
    if (this.session) {
      this.#emit(EVENTS.SESSION_END, { sessionId: this.session.id, messages: this.messages.length, tokens: this.tokens });
    }
    return this.save();
  }

  /**
   * Run a full agent task (tools and all) through the AgentRuntime.
   *
   * The streaming chat path above speaks to the gateway directly because tokens
   * must arrive live. Agent execution is a different shape -- a bounded,
   * tool-using run that returns one final result -- so it goes through the
   * runtime, which is exactly the "integrate AgentRuntime for task execution"
   * seam. The result is recorded in the conversation like any other turn.
   */
  async runAgent(task) {
    if (!this.runtime) return { ok: false, text: "agent runtime unavailable" };
    // Warm the map best-effort and inline its section into the context packet.
    // query picks up the task's own words so task-relevant files rank first.
    let extra;
    try {
      await this.mapBridge?.ensureWarm?.();
      if (this.mapBridge) {
        extra = this.mapBridge.extraFor({ query: typeof task === "string" ? task : (task?.text ?? "") });
      }
    } catch {
      extra = undefined; // the map is an optimisation, never a run gate
    }
    const result = await this.runtime.run({
      agentId: this.agentId,
      task,
      sessionId: this.session?.id ?? null,
      ...(extra ? { extra } : {}),
    });
    const raw = result?.output?.summary ?? result?.output ?? (result?.completed ? "completed" : "failed");
    const summary = typeof raw === "string" ? raw : JSON.stringify(raw);
    this.messages.push({ role: ROLE.ASSISTANT, content: summary });
    this.#record(ROLE.ASSISTANT, summary, { agent: this.agentId, completed: Boolean(result?.completed) });
    return { ok: Boolean(result?.completed), text: summary, result };
  }

  /**
   * Bind (or clear) the permission waterfall's human approver.
   *
   * The engine is built before a terminal exists -- the CLI creates the session,
   * then opens readline -- so the approver cannot be a constructor argument in
   * real use. Setting it here rebuilds the runtime so the new approver is the one
   * the next run consults; passing null restores fail-closed.
   */
  setApprover(fn) {
    this.approver = typeof fn === "function" ? fn : null;
    if (this.session) this.#buildRuntime();
  }

  // -------------------------------------------------------------------------
  // slash commands
  // -------------------------------------------------------------------------

  /**
   * Execute a slash command against this session.
   *
   * Returns a plain result the CLI renders: `{ kind, text, exit?, data? }`. State
   * changes (model switch, new session, clear, compact) happen here so they are
   * unit-testable without a terminal, and the CLI stays a thin renderer.
   *
   * @param {{ name: string, arg?: string }} parsed
   */
  async command(parsed) {
    const name = canonicalCommand(parsed?.name);
    const arg = parsed?.arg ?? "";

    switch (name) {
      case "help":
        return { kind: "help", text: SLASH_HELP };

      case "quit":
        return { kind: "quit", exit: true };

      case "model": {
        if (!arg) {
          return {
            kind: "model",
            text: `model: ${this.modelId ?? "(none)"}   provider: ${this.currentProvider ?? "(none)"}${this.fallback ? " (fallback)" : ""}`,
            data: this.getInfo(),
          };
        }
        const prev = this.modelId;
        this.modelId = arg;
        this.currentProvider = parseModelId(arg).provider;
        this.fallback = false;
        this.#updateHeader(this.currentProvider, arg);
        return { kind: "model", text: `model changed: ${prev ?? "(none)"} -> ${arg}` };
      }

      case "session":
        return { kind: "session", text: sessionText(this), data: this.getInfo() };

      case "sessions": {
        const list = typeof this.sessions?.list === "function" ? this.sessions.list({ limit: 10 }) : [];
        return { kind: "sessions", text: sessionsText(list), data: list.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })) };
      }

      case "new": {
        await this.save();
        this.session = this.createSession();
        this.messages = [];
        this.tokens = 0;
        this.compactionNote = null;
        this.fallback = false;
        this.fresh = true;
        if (typeof this.sessions.setCurrent === "function") this.sessions.setCurrent(this.session.id);
        return { kind: "new", text: `new session ${this.session.id}`, data: this.getInfo() };
      }

      case "clear": {
        const n = this.messages.length;
        this.messages = [];
        this.compactionNote = null;
        this.#recordNote(`cleared ${n} in-memory message(s)`);
        return { kind: "clear", text: `cleared ${n} message(s) from the prompt (session kept)` };
      }

      case "compact": {
        const result = await this.compact({ force: true });
        return {
          kind: "compact",
          text: result.compacted ? `compacted ${result.removed} message(s)` : "nothing to compact yet",
          data: result,
        };
      }

      case "tribunal": {
        if (!arg) return { kind: "tribunal", text: "usage: /tribunal <proposal>" };
        if (typeof this.handlers.tribunal !== "function") return { kind: "tribunal", text: "tribunal is not available in this session" };
        return { kind: "tribunal", text: await this.handlers.tribunal(arg) };
      }

      case "agent": {
        if (!arg) return { kind: "agent", text: "usage: /agent <task>" };
        // In chat, a task goes through the same bounded runtime as `aflow agent
        // run`, with this session's id, so a continuation can reconstruct from the
        // live conversation and any held approval is put to the user.
        const run = await this.runAgent(arg);
        return { kind: "agent", text: run.text, data: run.result };
      }

      case "doctor": {
        if (typeof this.handlers.doctor !== "function") return { kind: "doctor", text: "doctor is not available in this session" };
        return { kind: "doctor", text: await this.handlers.doctor() };
      }

      case "status": {
        return { kind: "status", text: this.statusText(), data: this.statusData() };
      }

      case "add": {
        if (!arg) return { kind: "add", text: "usage: /add <file>" };
        return { kind: "add", text: this.#addFile(arg).text };
      }

      case "drop": {
        if (!arg) return { kind: "drop", text: "usage: /drop <file>" };
        const before = this.contextFiles.length;
        this.contextFiles = this.contextFiles.filter((f) => f.path !== arg);
        return { kind: "drop", text: before === this.contextFiles.length ? `${arg} was not in context` : `removed ${arg} from context` };
      }

      case "context":
        return { kind: "context", text: this.#contextText(), data: { files: this.getInfo().contextFiles } };

      // Answered by the CLI, which has both a terminal and a shell. The engine
      // keeps this case so a caller that reaches it here gets a reason rather
      // than "unknown command".
      case "diff":
        return {
          kind: "diff",
          text: "/diff opens an interactive viewer in a terminal; run `git diff` for a plain view.",
        };

      // Like /diff, the timeline viewer needs a terminal; the CLI answers it
      // interactively. This case exists so a caller that reaches it here gets a
      // reason rather than "unknown command".
      case "timeline":
        return {
          kind: "timeline",
          text: "/timeline opens an interactive viewer in a terminal; session entries remain in the store.",
        };

      // Like /timeline, /swarm renders from the session's own entries in the
      // CLI; this case keeps a direct caller from getting "unknown command".
      case "swarm":
        return {
          kind: "swarm",
          text: "/swarm draws the session's agent handoff graph from its persisted agent runs.",
        };

      default: {
        // Plugin commands go before the unknown-command verdict, with the
        // same fail isolation they registered under.
        const pluginCommand = this.pluginManager?.command?.(name);
        if (pluginCommand) {
          return await this.pluginManager.runCommand(name, arg, this);
        }
        return { kind: "unknown", text: `unknown command: /${parsed?.name}. Type /help for the list.` };
      }
    }
  }

  #addFile(rel) {
    const root = this.workspaceRoot || this.projectRoot || process.cwd();
    const abs = path.resolve(root, rel);
    if (!isWithin(root, abs)) return { text: `refused: ${rel} resolves outside the project root` };
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (err) {
      return { text: `cannot read ${rel}: ${err?.message || err}` };
    }
    if (content.length > MAX_CONTEXT_FILE_CHARS) {
      content = `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n…[truncated at ${MAX_CONTEXT_FILE_CHARS} chars]`;
    }
    this.contextFiles = this.contextFiles.filter((f) => f.path !== rel);
    this.contextFiles.push({ path: rel, content });
    return { text: `added ${rel} (${content.length} chars) to context` };
  }

  #contextText() {
    const lines = [`context budget: ~${this.#estimatedChars()} / ${this.contextBudgetChars} chars`];
    if (!this.contextFiles.length) {
      lines.push("no files added; use /add <file>");
    } else {
      lines.push("files:");
      for (const f of this.contextFiles) lines.push(`  ${f.path} (${f.content.length} chars)`);
    }
    if (this.compactionNote) lines.push("conversation has a compacted summary in the prompt");
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // status line
  // -------------------------------------------------------------------------

  /** A one-line status, with a `tier` the CLI maps to a colour. */
  statusLine() {
    const provider = this.currentProvider || (this.modelId ? parseModelId(this.modelId).provider : "none");
    const status = this.#providerStatus(provider);
    const tier = status === PROVIDER_STATUS.DEAD || status === PROVIDER_STATUS.UNAUTHENTICATED
      ? "error"
      : this.fallback
        ? "fallback"
        : status === PROVIDER_STATUS.HEALTHY
          ? "healthy"
          : "unknown";
    const sid = this.session?.id ?? "no-session";
    const short = sid.length > 12 ? sid.slice(0, 12) : sid;
    const fb = this.fallback ? " (fallback)" : "";
    const plural = this.messages.length === 1 ? "" : "s";
    return {
      text: `[${this.modelId ?? "no-model"} | ${provider}${fb} | session ${short} | ${this.messages.length} message${plural}]`,
      tier,
      provider,
      model: this.modelId,
      fallback: this.fallback,
    };
  }

  statusText() {
    const provider = this.currentProvider || "(none)";
    const s = this.health.getProviderStatus(provider);
    const lines = [
      `model:    ${this.modelId ?? "(none)"}${this.fallback ? " (fallback)" : ""}`,
      `provider: ${provider}`,
      `status:   ${s.status}`,
      `circuit:  ${s.circuitState}`,
      `session:  ${this.session?.id ?? "(none)"}  (${this.messages.length} message(s), ~${this.tokens} tokens)`,
    ];
    return lines.join("\n");
  }

  statusData() {
    const provider = this.currentProvider || null;
    const s = provider ? this.health.getProviderStatus(provider) : null;
    return {
      model: this.modelId,
      provider,
      fallback: this.fallback,
      status: s?.status ?? null,
      circuitState: s?.circuitState ?? null,
      messages: this.messages.length,
      tokens: this.tokens,
      sessionId: this.session?.id ?? null,
    };
  }

  #providerStatus(provider) {
    if (!provider) return PROVIDER_STATUS.UNKNOWN;
    const rec = this.health.getProviderStatus(provider);
    return rec?.status ?? PROVIDER_STATUS.UNKNOWN;
  }

  // -------------------------------------------------------------------------
  // persistence helpers (best-effort: a store failure must not end the chat)
  // -------------------------------------------------------------------------

  #record(role, content, extra = {}) {
    if (!this.session || typeof this.sessions?.append !== "function") return;
    try {
      this.session = this.sessions.append(this.session.id, ENTRY_KIND.CONVERSATION, {
        role,
        content,
        at: new Date(this.now()).toISOString(),
        ...extra,
      });
    } catch (err) {
      this.#emit(EVENTS.SESSION_START, { persistError: err?.message || String(err) }, "warn");
    }
  }

  /**
   * Persist the usage records produced by the most recent route.
   *
   * One session entry carries the batch, so a cascade of six candidates is one
   * locked write rather than six. The ledger itself is bounded; this only writes
   * records that have not been persisted yet, which is what keeps a retried or
   * resumed turn from being counted twice.
   */
  #persistUsage() {
    if (!this.session || typeof this.sessions?.append !== "function") return;
    const all = this.usage.records();
    if (all.length <= this._usagePersisted) return;
    const fresh = all.slice(this._usagePersisted);
    try {
      const last = fresh[fresh.length - 1];
      this.sessions.append(this.session.id, ENTRY_KIND.USAGE, {
        model: last?.model ?? null,
        provider: last?.provider ?? null,
        requests: fresh,
      });
      // Advance only after a successful write. If the store refuses, the next
      // turn retries the same bounded batch instead of losing the observation.
      this._usagePersisted = all.length;
    } catch {
      /* best-effort: usage telemetry must not break the chat */
    }
  }

  #recordNote(text) {
    if (!this.session || typeof this.sessions?.append !== "function") return;
    try {
      this.sessions.append(this.session.id, ENTRY_KIND.NOTE, { text });
    } catch {
      /* best-effort */
    }
  }

  #recordError(message) {
    if (!this.session || typeof this.sessions?.append !== "function") return;
    try {
      this.sessions.append(this.session.id, ENTRY_KIND.ERROR, { message });
    } catch {
      /* best-effort */
    }
  }

  #recordTransition(transition) {
    if (!this.session || typeof this.sessions?.recordProviderTransition !== "function") return;
    try {
      this.sessions.recordProviderTransition(this.session.id, transition);
    } catch {
      /* best-effort */
    }
  }

  #updateHeader(provider, model) {
    if (!this.session || typeof this.sessions?.update !== "function") return;
    try {
      this.session = this.sessions.update(this.session.id, { provider, model });
    } catch {
      /* best-effort */
    }
  }

  #emit(type, payload = {}, level = "info") {
    try {
      this.log?.emit?.(type, payload, level);
    } catch {
      /* a broken logger must not take the chat down */
    }
  }
}

function isOnlyEmpty(failureKinds) {
  const kinds = Array.isArray(failureKinds) ? failureKinds : [];
  return kinds.length > 0 && kinds.every((k) => k === "empty");
}

function sessionText(chat) {
  const info = chat.getInfo();
  return [
    `session:  ${info.sessionId ?? "(none)"}`,
    `agent:    ${info.agentId}`,
    `model:    ${info.model ?? "(none)"}${info.fallback ? " (fallback)" : ""}`,
    `provider: ${info.provider ?? "(none)"}`,
    `messages: ${info.messages}`,
    `tokens:   ~${info.tokens}`,
  ].join("\n");
}

function sessionsText(list) {
  if (!list.length) return "no sessions yet";
  const lines = ["recent sessions:"];
  for (const s of list) {
    const title = s.name || s.objective || "(untitled)";
    lines.push(`  ${s.id}  ${truncate(title, 46)}  ${s.updatedAt ?? ""}`);
  }
  return lines.join("\n");
}

export default { ChatSession, ChatError, parseSlash, canonicalCommand, SLASH_HELP };
