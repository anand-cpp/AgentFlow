// Tool permissions and the three-waterfall tool pipeline.
//
// Reference design: AUDIT/DEEPSEEK_HARNESS_STUDY.md section 3.2. Seven steps:
//
//   1. tools/pre-execute   waterfall    hooks, permission, sandbox -> allow | deny | ask
//   2. registered monotonic guards       deny or abstain; identity is protected
//   3. tools/execute       waterfall    timeout, retry, metrics (around dispatch)
//      -> tool body execute()
//   4. tools/post-execute  waterfall    accept, block, replace, add context
//
// Only the pre-execute waterfall may rewrite a call. By the time the execute
// waterfall runs, permission, approval and the guards have all judged the call, so a
// rewrite there would dispatch something nobody approved -- and the pre-dispatch
// `tool.call` record would still describe the original. See the check in step 3.
//   5. registry outer normalization      snapshot throws become isError
//   6. finalization                       last content-only invariant
//   7. tools/result                     synchronous, frozen, one per call
//
// Two ordering decisions are load-bearing and easy to get backwards.
//
// Approval sits between pre-execute and the guards, not before pre-execute. An
// approved call still has to survive every guard, so a user who approves `rm -rf`
// does not thereby grant permission to delete the repository root.
//
// Guards are monotonic: they may only remove authority, never add it. A guard that
// returns "allow" is ignored, because a guard that can grant is a guard an LLM
// output can talk out of. That is the whole reason guards exist.
//
// The attempt is logged *before* dispatch. A crash mid-tool must leave a record
// that it was tried; otherwise an audit trail that misses exactly the calls that
// misbehaved is worse than none.

import { containsSecret } from "../redact.js";
import { TOOL_SCOPE } from "./registry.js";
import { safeErrorDetails } from "./tool-errors.js";

// Env var names matching any of these are dropped from a spawned command's
// environment. Broad on purpose: a false positive costs a tool one env var it
// probably did not need, while a false negative hands harness credentials to
// whatever the command prints.
const ENV_DROP = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION)/i;

export const OUTCOME = {
  OK: "ok",
  DENIED: "denied",
  ERROR: "error",
  // A step-thrown result. Orchestration stops here: a call that could not be
  // dispatched has no output to interpret.
  BLOCKED: "blocked",
};

export const STEP = {
  PRE: "pre-execute",
  GUARD: "guard",
  EXECUTE: "execute",
  POST: "post-execute",
  NORMALIZE: "normalize",
};

export class ToolError extends Error {
  constructor(message, code = "tool_error", details = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class ToolPermissionError extends ToolError {
  constructor(message, details = {}) {
    super(message, "permission_denied", details);
    this.name = "ToolPermissionError";
  }
}

/**
 * Drop credential-shaped environment variables from a spawn environment.
 *
 * Untrusted tool output never gets the ambient environment. A test run, a build,
 * or a `git` command inherits whatever the shell had, and its stderr goes into the
 * model's context -- which is a slow, indirect, entirely sufficient exfiltration
 * path.
 */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (ENV_DROP.test(name)) continue;
    // A value that is itself a credential is dropped even under a bland name.
    // `MY_SETTING` is not a safety property of the *value*, and providers are
    // creative about naming.
    if (containsSecret(value)) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

/**
 * Parse an allow/deny entry.
 *
 * Entries are `"<scope>:<value>"` because the registry stores them as plain
 * strings, and an unprefixed string is genuinely ambiguous: `src` is both a
 * plausible path and a plausible command. Forcing the scope into the entry removes
 * the guess, and makes `aflow agents` output greppable.
 *
 * The scope prefix is matched against the known vocabulary rather than split on
 * the first colon, so `network:https://api.example.com` keeps its URL intact.
 */
const ENTRY_RE = new RegExp(`^(${Object.values(TOOL_SCOPE).join("|")}):(.+)$`);

export function parseEntry(entry) {
  const m = ENTRY_RE.exec(String(entry ?? "").trim());
  if (!m) return null;
  return { scope: m[1], value: m[2].trim() };
}

function tokenize(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

/**
 * Is `child` inside `parent`?
 *
 * Segments are resolved lexically first, so `src/../../etc/passwd` cannot satisfy
 * an allowlist of `src`. A naive prefix test passes that string, which makes the
 * allowlist decorative for the one input it most needs to stop.
 *
 * Honest limit: this is lexical, so it does not follow symlinks or Windows
 * junctions. Containment against a real filesystem needs `fs.realpath`, which
 * belongs in the tool that touches the filesystem rather than here -- but the
 * tool must still do it. Lexical resolution is not a substitute.
 */
function pathWithin(parent, child) {
  const segments = (p) => {
    const out = [];
    for (const raw of String(p).replace(/\\/g, "/").split("/")) {
      if (!raw || raw === ".") continue;
      if (raw === "..") {
        out.pop();
        continue;
      }
      out.push(raw);
    }
    return out;
  };
  const a = segments(parent);
  const b = segments(child);
  if (!b.length) return false;
  if (b.length < a.length) return false;
  return a.every((seg, i) => b[i] === seg);
}

/**
 * Does one entry authorise this call?
 *
 * Shell-ish scopes match on the *tokenized* command, never the raw string.
 * Raw-substring matching is what lets `git status; rm -rf /` satisfy an allowlist
 * of `git`.
 */
function entryMatches(entry, call, toolScope) {
  if (entry.scope !== toolScope) return false;
  const args = call.args || {};

  if (entry.value === "*") return true;

  if (entry.scope === TOOL_SCOPE.SHELL || entry.scope === TOOL_SCOPE.TEST || entry.scope === TOOL_SCOPE.PACKAGE) {
    const command = String(args.command || args.cmd || "");
    if (!command) return false;
    const a = tokenize(entry.value);
    const b = tokenize(command);
    if (!a.length || a.length > b.length) return false;
    return a.every((tok, i) => tok === b[i]);
  }

  if (entry.scope === TOOL_SCOPE.NETWORK) {
    const url = String(args.url || args.host || "");
    if (!url) return false;
    const wanted = entry.value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    let host;
    try {
      // Exact host match. A prefix match would let `github.com.evil.test` satisfy
      // an allowlist of `github.com`, which makes the allowlist decorative.
      host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    } catch {
      return false;
    }
    return host === wanted;
  }

  if (entry.scope === TOOL_SCOPE.READ || entry.scope === TOOL_SCOPE.SEARCH || entry.scope === TOOL_SCOPE.WRITE) {
    return pathWithin(entry.value, String(args.path || ""));
  }

  // An unknown scope has no matching semantics, so it authorises nothing.
  return false;
}

/**
 * Evaluate the permission question for one call.
 *
 * Returns a decision rather than throwing: the caller routes `ask` differently
 * from `deny`, and "denied" is an expected outcome that belongs in a result
 * object, not an exception.
 *
 * `ask` is returned only when an approver was actually supplied. With none there
 * is nobody to answer, and an unanswerable prompt fails closed.
 */
export function evaluatePermission(agent, tool, call, { approver = null } = {}) {
  const policy = agent?.tools || {};
  const toolScope = tool?.scope;

  if (!toolScope) {
    return { decision: "deny", reason: `tool ${call.tool} declares no scope, so no policy can apply` };
  }

  const deny = (policy.deny || []).map(parseEntry).filter(Boolean);
  for (const entry of deny) {
    if (entryMatches(entry, call, toolScope)) {
      return { decision: "deny", reason: `${toolScope} matches a deny entry`, matched: entry.value };
    }
  }

  const allow = (policy.allow || []).map(parseEntry).filter(Boolean);
  const ask = (policy.ask || []).map(parseEntry).filter(Boolean);

  // The outer gate: a scope the agent was never granted. Entries naming their own
  // scope imply the grant, so a policy of only `allow` entries still works.
  const granted = new Set([...(policy.scopes || []), ...allow.map((e) => e.scope), ...ask.map((e) => e.scope)]);
  if (!granted.has(toolScope)) {
    return { decision: "deny", reason: `scope ${toolScope} is not granted to ${agent?.id ?? "the agent"}` };
  }

  // Order matters and is the whole policy:
  //   deny               -> refused outright; nothing overrides it
  //   scope approval     -> the whole scope asks, allowlist included
  //   allow entry        -> proceeds silently
  //   ask entry          -> proceeds only with approval
  //   otherwise          -> refused
  //
  // Scope-level approval dominating the allowlist is deliberate: "nothing in this
  // scope runs without a human" has to mean *nothing*, or it means nothing.
  //
  // `ask` is the other half, and it is what makes a narrow allowlist practical --
  // `allow: ["shell:git status"]` plus `ask: ["shell:*"]` gives an agent that can
  // run `git status` freely while `npm publish` still prompts. Scope-level
  // approval cannot express that; it would drag `git status` into the prompt too.
  if ((policy.requireApproval || []).includes(toolScope)) {
    if (!approver) return { decision: "deny", reason: `scope ${toolScope} requires approval and no approver is available` };
    return { decision: "ask", reason: `scope ${toolScope} requires approval` };
  }

  for (const entry of allow) {
    if (entryMatches(entry, call, toolScope)) {
      return { decision: "allow", reason: "matched an allow entry", matched: entry.value };
    }
  }

  if (ask.some((e) => entryMatches(e, call, toolScope))) {
    if (!approver) return { decision: "deny", reason: `${toolScope} requires approval and no approver is available` };
    return { decision: "ask", reason: `matched an ask entry for ${toolScope}` };
  }

  return { decision: "deny", reason: `no allow entry covers this ${toolScope} call` };
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

/**
 * Freeze a result, and its nested parts.
 *
 * Deep because this object is the authoritative record of what happened. A shallow
 * freeze leaves `result.error.message` writable, which is precisely the kind of
 * quiet mutation that makes a later "what did the tool actually say?" unanswerable.
 */
function freezeResult(result) {
  if (result.error) Object.freeze(result.error);
  if (Array.isArray(result.contexts)) Object.freeze(result.contexts);
  if (result.attempt) Object.freeze(result.attempt);
  return Object.freeze(result);
}

/**
 * A verdict from a waterfall step: `undefined`/`null` accepts and leaves the call
 * untouched. Anything returned replaces or blocks it.
 *
 * Returning "allow" is meaningless and ignored on purpose -- steps may only narrow.
 */
function applyStep(state, verdict) {
  if (verdict === undefined || verdict === null) return null;
  if (verdict === true) return null;
  if (typeof verdict !== "object") {
    throw new ToolError(`waterfall step returned ${typeof verdict}; expected a verdict object`, "bad_verdict");
  }
  const action = verdict.action || "deny";
  if (action === "allow") return null; // narrowing only
  if (action === "transform") {
    return { transform: verdict.call ?? state.call };
  }
  if (action === "addContext") {
    return { addContext: verdict.content };
  }
  if (action === "replace") {
    return { replace: verdict.result };
  }
  if (action === "deny" || action === "block") {
    return { deny: verdict.reason || "blocked by a waterfall step" };
  }
  throw new ToolError(`unknown waterfall action ${JSON.stringify(action)}`, "bad_verdict");
}

/**
 * Run one tool call through the full pipeline.
 *
 * Never throws for a tool-level problem. Any throw becomes a frozen isError
 * result, because a tool that throws inside an agent loop otherwise takes the
 * whole run down with it.
 */
export async function runTool(agent, tool, call, ctx = {}) {
  const {
    preExecute = [],
    guards = [],
    execute = [],
    postExecute = [],
    approver = null,
    now = () => Date.now(),
    signal = null,
  } = ctx;

  const log = ctx.log || nullLog();
  let state = {
    call: { tool: call.tool, args: call.args || {}, scope: tool?.scope || null, id: call.id || null },
    contexts: [],
    approval: null,
  };

  const finish = (result) => freezeResult(result);

  // Step 1: pre-execute waterfall.
  let attempt = null;
  try {
    for (const step of preExecute) {
      const applied = applyStep(state, await step(state, { ...ctx, agent, tool }));
      if (!applied) continue;
      if (applied.deny) return finish(denyResult(state, applied.deny, "pre-execute", log));
      if (applied.transform) state = { ...state, call: applied.transform };
      if (applied.addContext) state.contexts.push(applied.addContext);
    }

    // Permission, then approval, then guards. See the ordering note at the top.
const verdict = evaluatePermission(agent, tool, state.call, { approver });
      if (verdict.decision === "deny") {
        notify(ctx.onDecision, state, { decision: "deny", granted: false, reason: verdict.reason });
        return finish(denyResult(state, verdict.reason, "pre-execute", log));
      }
      if (verdict.decision === "ask") {
        let approved = false;
        try {
          approved = (await approver(state.call, tool)) === true;
        } catch {
          // Fail closed. An approver that crashes -- a closed dialog, a dead TTY,
          // a lost connection -- must never read as consent. Strict `=== true` too:
          // a UI returning 1 or "yes" has not answered the question that was asked.
          approved = false;
        }
        state.approval = { granted: approved, reason: verdict.reason };
        // Announced here, at the instant the authority settles, rather than by the
        // caller after runTool returns. The caller cannot know the outcome before it
        // happens, so a post-hoc event necessarily arrives after the tool has already
        // run -- and an event log that reads `started` before `approved` is not
        // describing the order things happened in. Observation only: the decision was
        // made above and this hook cannot change it.
        notify(ctx.onDecision, state, {
          decision: "ask",
          granted: approved,
          reason: verdict.reason,
        });
        if (!approved) {
          return finish(denyResult(state, "approval was not granted", "pre-execute", log));
        }
      } else {
        notify(ctx.onDecision, state, { decision: "allow", granted: null, reason: null });
      }

    // Step 2: monotonic guards. May only remove authority.
    for (const guard of guards) {
      const v = await guard(state.call, { ...ctx, agent, tool, approval: state.approval });
      // A guard returning allow/abstain cannot grant. Only deny/block stops.
      if (v === false) {
        return finish(denyResult(state, "a guard denied the call", "guard", log));
      }
      if (v && typeof v === "object" && (v.action === "deny" || v.action === "block" || v.ok === false)) {
        return finish(denyResult(state, v.reason || "a guard denied the call", "guard", log));
      }
    }

    // Credential gate. A tool call is not persisted verbatim by default, but its
    // output is fed back to the model, so refusing here is cheaper than scrubbing
    // a leak that already reached the transcript.
    if (containsSecret(JSON.stringify(state.call))) {
      return finish(denyResult(state, "call arguments contain a credential-shaped value", "guard", log));
    }

    // The attempt is recorded before dispatch, not after.
    attempt = { tool: state.call.tool, scope: state.call.scope, args: state.call.args };
    log.emit("tool.call", attempt);
    // And so is the fact that execution is beginning. This is the only point in the
    // pipeline at which "started" is true: permission, approval and the guards have
    // all cleared, and the tool body has not yet run. A caller that emitted it before
    // asking for permission would be reporting a call as started that is about to be
    // refused -- which is how a log ends up claiming work happened that never did.
    notify(ctx.onDispatch, state, { phase: "dispatch" });
  } catch (err) {
    return finish(errorResult(state, err, "pre-execute", log));
  }

  // Step 3: execute waterfall around dispatch.
  let raw;
  try {
    for (const step of execute) {
      const applied = applyStep(state, await step(state, { ...ctx, agent, tool }));
      if (!applied) continue;
      if (applied.deny) return finish(denyResult(state, applied.deny, "execute", log));
      if (applied.transform) {
        // Refused rather than honoured, and this is a security boundary rather than
        // a style preference.
        //
        // A transform here would rewrite the call *after* permission, approval and
        // the guards have already judged it -- so a hook could take a call that was
        // allowlisted and approved, replace it with one that is neither, and have it
        // dispatched. The pre-dispatch `tool.call` record would also still describe
        // the original arguments, so the audit trail would faithfully record the
        // wrong command.
        //
        // There is a legitimate way to rewrite a call: the pre-execute waterfall,
        // which runs before anything is judged. Use that.
        return finish(
          errorResult(
            state,
            new Error(
              "the execute waterfall may not transform a call: it runs after permission, " +
                "approval and guards. Use a pre-execute step, which runs before them.",
            ),
            "execute",
            log,
          ),
        );
      }
    }
    raw = await tool.execute(state.call.args, { ...ctx, agent, env: scrubEnv(ctx.env || process.env), signal, now });
  } catch (err) {
    // Step 5 normalization starts here: a throw is an error result, not a crash.
    return finish(errorResult(state, err, "execute", log));
  }

  // Step 4: post-execute waterfall.
  let result = { output: raw };
  try {
    for (const step of postExecute) {
      const applied = applyStep(state, await step(result, { ...ctx, agent, tool }));
      if (!applied) continue;
      if (applied.deny) return finish(denyResult(state, applied.deny, "post-execute", log));
      if (applied.replace) result = applied.replace;
      if (applied.addContext) state.contexts.push(applied.addContext);
    }
  } catch (err) {
    return finish(errorResult(state, err, "post-execute", log));
  }

  // Step 6/7: normalize and freeze. One authoritative outcome per call.
  return finish({
    outcome: OUTCOME.OK,
    tool: state.call.tool,
    scope: state.call.scope,
    output: result.output ?? null,
    contexts: state.contexts,
    approved: Boolean(state.approval?.granted),
    attempt,
    error: null,
  });
}

function denyResult(state, reason, step, log) {
  log.emit("tool.denied", { tool: state.call.tool, scope: state.call.scope, reason, step });
  return {
    outcome: OUTCOME.DENIED,
    tool: state.call.tool,
    scope: state.call.scope,
    output: null,
    contexts: [],
    approved: Boolean(state.approval?.granted),
    attempt: null,
    error: { code: "permission_denied", message: reason, step },
  };
}

function errorResult(state, err, step, log) {
  log.emit("tool.error", { tool: state.call.tool, scope: state.call.scope, message: err?.message, step });
  // A tool's own structured details are carried across when it offered them: a
  // read that refused an oversized file should be able to say how large it was,
  // and a shell timeout which limit fired. Scalars only (see safeErrorDetails), so
  // this cannot widen what a result is able to carry into a session or an event.
  const details = safeErrorDetails(err);
  return {
    outcome: OUTCOME.ERROR,
    tool: state.call.tool,
    scope: state.call.scope,
    output: null,
    contexts: [],
    approved: Boolean(state.approval?.granted),
    attempt: null,
    error: { code: err?.code || "tool_error", message: err?.message || String(err), step, ...(details || {}) },
  };
}

function nullLog() {
    return { emit() { return null; }, errorCount: 0 };
  }

  /**
   * Tell a caller what the pipeline just decided, at the moment it decided.
   *
   * Two hooks, both strictly observers: `onDecision` at the permission verdict, and
   * `onDispatch` at the moment the tool body is about to run. They exist because the
   * caller cannot know either fact in advance, and reconstructing them afterwards
   * gives the wrong answer -- a "started" event emitted before permission was
   * requested reports work that may never have happened.
   *
   * Observation only. The hooks run after the fact is fixed and return nothing the
   * pipeline consults, so adding them cannot turn one decision point into two -- which
   * is the failure this whole module exists to prevent. A hook that throws is
   * swallowed for the same reason a throwing logger is: an observer that can take
   * down a run it is only watching has the wrong power.
   */
  function notify(hook, state, info) {
    if (typeof hook !== "function") return;
    try {
      hook({
        ...info,
        tool: state.call.tool,
        scope: state.call.scope,
        // The call as judged, not as requested. Only pre-execute may transform, and
        // it has already run at this point, so this is the exact call that is about
        // to run or has just been refused.
        args: state.call.args,
      });
    } catch {
      /* an observer must not be able to fail the call it observes */
    }
  }

export default {
  runTool,
  evaluatePermission,
  scrubEnv,
  OUTCOME,
  STEP,
  ToolError,
  ToolPermissionError,
};
