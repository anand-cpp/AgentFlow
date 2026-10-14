// Cross-provider continuity primitives.
//
// The ProviderHealth engine decides *whether* a provider is currently usable;
// these primitives decide *whether an interrupted run may be continued elsewhere*
// and *which parts of it are safe to re-attempt*. They are deliberate in what
// they refuse to do:
//
//  - A malformed request (invalid_request) or a user cancellation must not be
//    shipped to a second provider: another provider will not fix a request we
//    sent wrong, and a user who pressed stop did not ask for a retry.
//  - A dispatched tool call whose outcome is unknown must not be replayed
//    blindly. Reads and searches are safe to retry; writes and shell commands
//    are not, so those pause for approval.
//  - Continuation is decision-only here. No network calls, no live state. The
//    caller sequences the primitives; `continueSession` ties them to the stores,
//    the event log and the health engine in the documented order.

import { EVENTS } from "./events.js";
import { FAILURE_CLASS } from "./provider-health.js";
import { buildContextPacket, budgetContextPacket, renderContextPacket, ContextPacketError } from "./context-packet.js";
import { nullLog } from "./events.js";

// Failure classes for continuity. Spelling intentionally matches FAILURE_CLASS
// where the concepts overlap, so a class can feed the health engine unchanged;
// the three additional classes are request/user facts, not provider health facts.
export const PROVIDER_FAILURE = {
  RATE_LIMITED: "rate_limited",
  QUOTA: "quota",
  NO_CREDENTIALS: "no_credentials",
  UNAUTHENTICATED: "unauthenticated",
  AUTH: "auth",
  INVALID_REQUEST: "invalid_request",
  CONTEXT_OVERFLOW: "context_overflow",
  CANCELLED: "cancelled",
  SERVER: "server",
  NETWORK: "network",
  EMPTY: "empty",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
};

// Scopes whose blind re-run can duplicate side effects. Reads, searches and
// tests are safe to re-attempt; writes, shell, network, package and release
// are not -- a second `write` or a second `npm publish` is a different event.
// An unknown scope is treated as non-idempotent, because the alternative is
// rerunning an operation with consequences nobody has certified.
export const NON_IDEMPOTENT_SCOPES = new Set(["write", "shell", "network", "package", "release"]);

export const TOOL_VERDICT = {
  NOT_EXECUTED: "not_executed",
  CERTAIN: "certain",
  UNCERTAIN: "uncertain",
};

/**
 * Map a continuity failure class onto a provider-health class.
 *
 * Request/user facts (invalid_request, context_overflow, cancelled) map to null
 * on purpose: they say nothing about the provider's health, and routing them as
 * provider failures would open a circuit over a bad request. The provider health
 * engine only learns facts it can actually use.
 */
export function toHealthClass(failure) {
  switch (failure) {
    case PROVIDER_FAILURE.RATE_LIMITED:
      return FAILURE_CLASS.RATE_LIMITED;
    case PROVIDER_FAILURE.QUOTA:
      return FAILURE_CLASS.QUOTA;
    case PROVIDER_FAILURE.NO_CREDENTIALS:
      return FAILURE_CLASS.NO_CREDENTIALS;
    case PROVIDER_FAILURE.UNAUTHENTICATED:
      return FAILURE_CLASS.UNAUTHENTICATED;
    case PROVIDER_FAILURE.AUTH:
      return FAILURE_CLASS.AUTH;
    case PROVIDER_FAILURE.SERVER:
      return FAILURE_CLASS.SERVER;
    case PROVIDER_FAILURE.NETWORK:
      return FAILURE_CLASS.NETWORK;
    case PROVIDER_FAILURE.EMPTY:
      return FAILURE_CLASS.EMPTY;
    case PROVIDER_FAILURE.TIMEOUT:
      return FAILURE_CLASS.TIMEOUT;
    case PROVIDER_FAILURE.UNKNOWN:
      return FAILURE_CLASS.UNKNOWN;
    default:
      return null;
  }
}

/**
 * Classify a provider error.
 *
 * Ordering matters. Cancellation and credentials are checked first because they
 * have the most specific consequences; auth before rate-limit so "401" is not
 * swallowed by the 429 rule; request/context problems before network because a
 * 400 is not a connectivity problem.
 */
export function classifyProviderFailure(err, { cancelled = false } = {}) {
  if (cancelled || err?.name === "AbortError") {
    return { failure: PROVIDER_FAILURE.CANCELLED, switchable: false, reason: "cancelled_by_user" };
  }
  if (!err) return { failure: PROVIDER_FAILURE.UNKNOWN, switchable: true, reason: "no_error_object", uncertain: true };

  const text = `${err.code || ""} ${err.status || err.statusCode || ""} ${err.message || err}`.toLowerCase();

  if (/missing api key|no api key|api key (?:not )?(?:required|missing)|invalid_api_key|missing.*key/.test(text)) {
    return { failure: PROVIDER_FAILURE.NO_CREDENTIALS, switchable: true, reason: "credentials_absent_or_rejected" };
  }
  if (/401|unauthorized|unauthenticated|authentication (?:failed|error)/.test(text)) {
    return { failure: PROVIDER_FAILURE.UNAUTHENTICATED, switchable: true, reason: "credentials_rejected" };
  }
  if (/403|forbidden|permission denied/i.test(text)) {
    return { failure: PROVIDER_FAILURE.AUTH, switchable: true, reason: "access_forbidden" };
  }
  if (/429|rate.?limit|too many requests/.test(text)) {
    return { failure: PROVIDER_FAILURE.RATE_LIMITED, switchable: true, reason: "rate_limited" };
  }
  if (/quota|quota_exceeded|insufficient_quota|billing/.test(text)) {
    return { failure: PROVIDER_FAILURE.QUOTA, switchable: true, reason: "quota_exhausted" };
  }
  if (/context (?:length|window|limit)|max_context|max_tokens|prompt is too long|too many tokens|input token(?:s)? limit|length of the prompt/.test(text)) {
    return { failure: PROVIDER_FAILURE.CONTEXT_OVERFLOW, switchable: true, reason: "context_window_overflow" };
  }
  if (/400|422|invalid_request|bad request|malformed|invalid parameter|invalid request|schema.*invalid|invalid input/.test(text)) {
    return { failure: PROVIDER_FAILURE.INVALID_REQUEST, switchable: false, reason: "no_other_provider_fixes" };
  }
  if (/timeout|timed ?out|etimedout|deadline|socket hang up/.test(text)) {
    return { failure: PROVIDER_FAILURE.TIMEOUT, switchable: true, reason: "request_timed_out" };
  }
  if (/econnrefused|enotfound|network|fetch failed|dns|offline|unreachable|connection refused/.test(text)) {
    return { failure: PROVIDER_FAILURE.NETWORK, switchable: true, reason: "provider_unreachable" };
  }
  if (/50\d|502|503|504|bad gateway|service unavailable|upstream/.test(text)) {
    return { failure: PROVIDER_FAILURE.SERVER, switchable: true, reason: "provider_server_error" };
  }
  if (/empty|no content|zero.?token|no choices/.test(text)) {
    return { failure: PROVIDER_FAILURE.EMPTY, switchable: true, reason: "empty_response" };
  }
  return { failure: PROVIDER_FAILURE.UNKNOWN, switchable: true, reason: "unclassifiable", uncertain: true };
}

/**
 * Is this failure one a *different* provider can absorb?
 *
 * `candidates` is how many alternative provider/model pairs are left to try.
 * `candidateHasCapacity` is set when a candidate advertises a larger context
 * window than the one that overflowed. Circuit state of the candidate provider
 * is reflected here too, so a candidate that is itself open is not counted.
 */
export function fallbackEligibility({
  failureClass = PROVIDER_FAILURE.UNKNOWN,
  candidates = 0,
  candidateHasCapacity = false,
  // Accepted for call-site symmetry with planContinuation; candidate circuit
  // state is enforced by the health engine before this primitive is consulted.
  candidateCircuitState = null,
} = {}) {
  void candidateCircuitState;
  const none = { eligible: false, reason: "no_candidate", uncertain: false };
  if (candidates <= 0) return none;

  switch (failureClass) {
    case PROVIDER_FAILURE.INVALID_REQUEST:
      return { eligible: false, reason: "no_other_provider_fixes", uncertain: false };
    case PROVIDER_FAILURE.CANCELLED:
      return { eligible: false, reason: "cancelled_by_user", uncertain: false };
    case PROVIDER_FAILURE.CONTEXT_OVERFLOW:
      return candidateHasCapacity
        ? { eligible: true, reason: "candidate_has_more_context", uncertain: false }
        : { eligible: false, reason: "no_candidate_has_more_context", uncertain: false };
    case PROVIDER_FAILURE.NO_CREDENTIALS:
    case PROVIDER_FAILURE.UNAUTHENTICATED:
    case PROVIDER_FAILURE.AUTH:
      // Broken credentials for one provider say nothing about another. Note
      // that provider-level skips and circuit state are enforced by the health
      // engine and routing before this primitive is consulted.
      return { eligible: true, reason: "switch_provider", uncertain: false };
    case PROVIDER_FAILURE.RATE_LIMITED:
    case PROVIDER_FAILURE.QUOTA:
    case PROVIDER_FAILURE.SERVER:
    case PROVIDER_FAILURE.NETWORK:
    case PROVIDER_FAILURE.EMPTY:
    case PROVIDER_FAILURE.TIMEOUT:
      return { eligible: true, reason: "different_provider_may_succeed", uncertain: false };
    default:
      // UNKNOWN: another provider might work, but we have no evidence either
      // way. This never authorises a blind side-effecting replay on its own.
      return { eligible: true, reason: "unknown_failure_uncertain", uncertain: true };
  }
}

/**
 * Judge how safely one tool call can be re-attempted.
 *
 * Evidence is deliberately binary: a recorded result makes the outcome certain;
 * a dispatch with no record makes it uncertain. Only reads/searches/tests are
 * replayed without asking, and only when they were never observed to complete.
 */
export function toolRecoverySituation({ tool = null, scope = null, dispatched = false, recorded = null } = {}) {
  // `tool` names the call being judged; the verdict depends only on
  // scope/recorded/dispatched, so it is accepted but not otherwise read.
  void tool;
  if (recorded) {
    const terminal = recorded.ok === true || recorded.status === "ok";
    const failed = recorded.status === "denied" || recorded.status === "error" || recorded.status === "cancelled";
    return {
      situation: TOOL_VERDICT.CERTAIN,
      canReplay: false,
      complete: terminal || failed,
      reason: terminal ? "outcome_recorded_success" : failed ? "outcome_recorded_failure" : "outcome_recorded",
      action: "none",
      scope: scope ?? null,
    };
  }
  if (!dispatched) {
    return {
      situation: TOOL_VERDICT.NOT_EXECUTED,
      canReplay: true,
      complete: false,
      reason: semanticIdempotence(scope) ? "never_dispatched_idempotent" : "never_dispatched",
      action: "retry",
      scope: scope ?? null,
    };
  }
  // Dispatched, no record: the tool ran (or may have run) and we cannot see the
  // result. Idempotent scopes may be re-run; anything else or unknown must stop.
  const idempotent = semanticIdempotence(scope);
  return {
    situation: TOOL_VERDICT.UNCERTAIN,
    canReplay: idempotent,
    complete: false,
    reason: idempotent ? "dispatched_unrecorded_idempotent" : "dispatched_unrecorded_nondeterministic",
    action: idempotent ? "retry" : "require_approval",
    scope: scope ?? null,
  };
}

function semanticIdempotence(scope) {
  return scope !== null && scope !== undefined && !NON_IDEMPOTENT_SCOPES.has(scope);
}

/**
 * Decide whether a batch of tool calls may be continued automatically.
 *
 * The outcome is a summary, not an approval: a `safe` batch can proceed; a
 * `requireApproval` batch names the calls that must be shown to a human before
 * anything else runs.
 */
export function assertSafeContinuation({ toolCalls = [] } = {}) {
  const requireApproval = [];
  const canRetryIdempotent = [];
  let safe = true;

  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const situation = toolRecoverySituation(call);
    if (situation.situation === TOOL_VERDICT.UNCERTAIN && !situation.canReplay) {
      requireApproval.push({ tool: call.tool ?? null, scope: call.scope ?? null, reason: situation.reason });
      safe = false;
    } else if (situation.situation === TOOL_VERDICT.UNCERTAIN) {
      canRetryIdempotent.push({ tool: call.tool ?? null, scope: call.scope ?? null });
    }
  }

  return { safe, requireApproval, canRetryIdempotent };
}

/**
 * The one decision that ties the primitives together: may the run attempt a
 * switch to another provider right now?
 *
 * `dispatchUncertainties` is the number of dispatched-but-unrecorded
 * non-idempotent tool calls; any such call forces approval before anything is
 * retried, because the continuation cannot know what the earlier run already
 * did.
 */
export function planContinuation({
  failureClass = PROVIDER_FAILURE.UNKNOWN,
  candidates = 0,
  candidateHasCapacity = false,
  candidateCircuitState = null,
  dispatchUncertainties = 0,
} = {}) {
  if (candidates <= 0) return { action: "stop", reason: "no_candidate", failureClass };
  if (dispatchUncertainties > 0) {
    return {
      action: "require_approval",
      reason: "uncertain_tool_outcomes",
      failureClass,
      uncertain: dispatchUncertainties,
    };
  }

  const eligibility = fallbackEligibility({ failureClass, candidates, candidateHasCapacity, candidateCircuitState });
  if (!eligibility.eligible) return { action: "stop", reason: eligibility.reason, failureClass };
  if (eligibility.uncertain) {
    return { action: "require_approval", reason: eligibility.reason, failureClass, uncertain: true };
  }
  return { action: "attempt_switch", reason: eligibility.reason, failureClass };
}

/**
 * Reconstruct a session's context packet and attempt a continuation on a given
 * provider/model.
 *
 * The after-failure sequence, in documented order:
 *   classify the prior failure; decide eligibility; reconstruct + budget the
 *   packet from the stores; emit context.built / context.reconstructed;
 *   (if approved) emit continuation.started and call `complete`; feed the
 *   outcome back to health; persist the packet and any provider transition;
 *   emit continuation.completed / continuation.failed.
 *
 * `complete` receives `(config, modelId, prompt, { system })` and returns a
 * result with `.text` -- the same contract the agent runtime uses, so a live
 * gateway and a test double are interchangeable here.
 */
export async function continueSession({
  sessions = null,
  blackboard = null,
  sessionId = null,
  modelId = null,
  complete = null,
  failure = null,
  cancelled = false,
  health = null,
  log = null,
  contextWindow = null,
  reserveChars = 0,
  budgetChars = null,
  task = null,
  extra = null,
  agentId = null,
  now = null,
  uncertainDispatches = 0,
} = {}) {
  const logger = log ?? nullLog();
  const receipt = {
    action: "stop",
    reason: null,
    failureClass: null,
    packet: null,
    outcome: null,
  };

  if (!sessions || !sessionId) {
    receipt.reason = "no_session_store";
    return receipt;
  }

  let session;
  try {
    session = sessions.read(sessionId);
  } catch (err) {
    receipt.reason = `session_unreadable: ${err?.message || err}`;
    return receipt;
  }

  const classification = classifyProviderFailure(failure, { cancelled });
  receipt.failureClass = classification.failure;

  const prior = {
    provider: session.provider ?? null,
    model: session.model ?? null,
  };

  // The current runtime records one TOOL_RESULT per executed call, so a session
  // read from store has no unrecorded dispatches. A caller equipped with a
  // dispatch tracer can supply the real count; until then 0 is the truth, not a
  // fashion statement.
  const uncertainties = Math.max(0, Number.isFinite(uncertainDispatches) ? Math.round(uncertainDispatches) : 0);
  const plan = planContinuation({
    failureClass: classification.failure,
    candidates: modelId ? 1 : 0,
    dispatchUncertainties: uncertainties,
  });
  receipt.action = plan.action;
  receipt.reason = plan.reason;

  let packet;
  try {
    packet = budgetContextPacket(
      buildContextPacket({ session, blackboard, task, extra, agentId, now }),
      { contextWindow, reserveChars, budgetChars },
    );
  } catch (err) {
    if (err instanceof ContextPacketError) {
      logger.error(EVENTS.CONTEXT_REJECTED, {
        sessionId,
        code: err.code,
        message: err.message,
        failureClass: classification.failure,
      });
      receipt.reason = `context_rejected: ${err.message}`;
      return receipt;
    }
    throw err;
  }
  receipt.packet = packet;

  if (plan.action !== "attempt_switch") {
    // The plan is to stop or to ask. The packet is still recorded so the 
    // decision and the state are reconstructable later.
    recordPacket(sessions, sessionId, packet, agentId, logger);
    if (uncertainties > 0) {
      logger.warn(EVENTS.TOOL_OUTCOME_UNCERTAIN, {
        sessionId,
        count: uncertainties,
        note: "dispatched tool calls with no recorded outcome; continuation requires approval",
      });
    }
    return receipt;
  }

  if (!complete) {
    receipt.action = "stop";
    receipt.reason = "no_complete_function";
    return receipt;
  }

  const candidate = parseCandidate(modelId);
  // `provider` is the prefix; `model` stays the full id, matching the meaning of
  // session.model ("provider/name"), so a transition reads the same on both sides.
  const provider = candidate.provider;
  const model = modelId;
  const isSwitch = prior.provider !== provider || prior.model !== model;
  const prompt = renderPrompt(packet);

  logger.info(EVENTS.CONTEXT_RECONSTRUCTED, {
    sessionId,
    from: prior.provider ?? null,
    to: provider,
    model,
    chars: sizeOfPacket(packet),
    budget: packet.metadata?.budget ?? null,
    limitSource: packet.metadata?.limitSource ?? null,
  });
  logger.info(EVENTS.CONTINUATION_STARTED, {
    sessionId,
    provider,
    model,
    failureClass: classification.failure,
  });

  try {
    // `complete` mirrors the agent runtime's contract: (config, modelId, prompt,
    // opts). The prompt already carries the continuation header, so no system
    // text is added here.
    const result = await complete(null, modelId, prompt, { system: null });
    const text = typeof result?.text === "string" ? result.text : result?.output ?? null;

    if (health && provider) {
      health.onSuccess(provider, { model });
    }

    const transition = isSwitch
      ? { from: prior, to: { provider, model }, failureClass: classification.failure, reason: plan.reason }
      : null;
    if (transition) {
      recordTransition(sessions, sessionId, transition, agentId, logger);
      try {
        sessions.update(sessionId, { provider, model });
      } catch {
        /* the entry already carries the fact */
      }
    }
    recordPacket(sessions, sessionId, packet, agentId, logger);

    logger.info(EVENTS.CONTINUATION_COMPLETED, {
      sessionId,
      provider,
      model,
    });

    receipt.action = "continued";
    receipt.outcome = { ok: true, text };
    return receipt;
  } catch (err) {
    const next = classifyProviderFailure(err);
    const healthClass = toHealthClass(next.failure);
    if (health && provider && healthClass) {
      health.onFailure(provider, healthClass, { model });
    }
    logger.error(EVENTS.CONTINUATION_FAILED, {
      sessionId,
      provider,
      model,
      failureClass: next.failure,
      message: err?.message || String(err),
    });
    receipt.action = "failed";
    receipt.reason = next.reason;
    receipt.outcome = { ok: false, failureClass: next.failure, message: err?.message || String(err) };
    return receipt;
  }
}

function renderPrompt(packet) {
  // The wire prompt is a rendering of the packet with its own header telling the
  // receiving model this is a continuation, so a fresh provider cannot mistake a
  // mid-task packet for a new task.
  return [
    "CONTINUATION — a previous attempt at this work was interrupted. Continue the task,",
    "assume the recorded facts are accurate, and ask before re-running anything whose",
    "outcome is not recorded.",
    "",
    renderContextPacket(packet),
  ].join("\n");
}

function parseCandidate(modelId) {
  const raw = String(modelId ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash === -1) return { provider: raw || null, model: raw || null };
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

function sizeOfPacket(value) {
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function recordPacket(sessions, sessionId, packet, agentId, logger) {
  try {
    sessions.recordContext(sessionId, packet, { agent: agentId });
    const truncated = packet.metadata?.truncated ?? {};
    logger.info(EVENTS.CONTEXT_BUILT, {
      sessionId,
      chars: sizeOfPacket(packet),
      budget: packet.metadata?.budget ?? null,
      limitSource: packet.metadata?.limitSource ?? null,
    });
    if (Object.keys(truncated).length > 0) {
      logger.info(EVENTS.CONTEXT_TRUNCATED, {
        sessionId,
        omitted: truncated,
      });
    }
  } catch (err) {
    logger.warn(EVENTS.CONTEXT_REJECTED, { sessionId, message: `packet not persisted: ${err?.message || err}` });
  }
}

function recordTransition(sessions, sessionId, transition, agentId, logger) {
  try {
    sessions.recordProviderTransition(sessionId, transition, { agent: agentId });
  } catch (err) {
    logger.warn(EVENTS.CONTINUATION_FAILED, { sessionId, message: `transition not persisted: ${err?.message || err}` });
  }
}

export default {
  PROVIDER_FAILURE,
  NON_IDEMPOTENT_SCOPES,
  TOOL_VERDICT,
  toHealthClass,
  classifyProviderFailure,
  fallbackEligibility,
  toolRecoverySituation,
  assertSafeContinuation,
  planContinuation,
  continueSession,
};