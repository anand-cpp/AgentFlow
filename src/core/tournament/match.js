// One Arena match: attack, defend, revise, judge.
//
// The bracket owns the tournament. This module owns a single match and nothing
// else: it does not advance rounds, does not write files, and does not decide
// that a failed match has a winner. It returns a structured result -- artifacts,
// a validated decision, and an explicit status -- that the driver can persist
// and apply with applyMatchResult().
//
// The execution contract is deliberately boring:
//
//   * Seven model calls at most in the happy path: two attacks, two defenses,
//     two revisions, one judge. `maxCalls` is a hard ceiling that also covers
//     retries, so a misbehaving provider cannot turn one match into an
//     unbounded bill.
//   * Every response is parsed and validated. A malformed response is retried
//     within the same ceiling, then the match fails -- it never falls back to a
//     default winner or a default score.
//   * Provider failures are classified with the router's classifyFailure(), so
//     a 429 and a missing API key behave differently and both are recorded.
//   * Cancellation is checked before every call and raced against in-flight
//     calls. A cancelled match returns the artifacts it already has, which is
//     exactly what a later resume needs.
//   * `resume.artifacts` skips stages that already succeeded. Completed matches
//     are skipped by the driver, not here.

import { classifyFailure, dispositionFor } from "../routing.js";
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  decisionToMatchResult,
  decideMatch,
  parseJudgeJson,
} from "./judge.js";
import { parseModelJson } from "./json.js";
import {
  ATTACK_SYSTEM_PROMPT,
  DEFENSE_SYSTEM_PROMPT,
  REVISION_SYSTEM_PROMPT,
  buildAttackPrompt,
  buildDefensePrompt,
  buildRevisionPrompt,
  validateAttackResponse,
  validateDefenseResponse,
  validateRevisionResponse,
} from "./match-schema.js";

/** Calls one clean match uses: 2 attacks + 2 defenses + 2 revisions + 1 judge. */
export const BASE_MATCH_CALLS = 7;

/** Headroom above the happy path, covering retries and a re-asked judge. */
export const DEFAULT_MAX_CALLS = 12;

export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_RETRY_DELAY_MS = 250;

export const MATCH_STATUS = Object.freeze({
  DECIDED: "decided",
  UNRESOLVED: "unresolved",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

/** Failure kinds this module adds to the router's vocabulary. */
export const STAGE_FAILURE = Object.freeze({
  BUDGET: "budget_exhausted",
  INVALID: "invalid_response",
});

const DEFAULT_TOKENS = Object.freeze({
  attack: 900,
  defense: 800,
  revision: 1600,
  judge: 1400,
});

const SIDES = Object.freeze(["candidate_a", "candidate_b"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function otherSide(side) {
  return side === "candidate_a" ? "candidate_b" : "candidate_a";
}

function abortError(reason) {
  const err = /** @type {Error & { cancelled: boolean }} */ (
    new Error(typeof reason === "string" && reason ? reason : "arena match cancelled")
  );
  err.name = "AbortError";
  err.cancelled = true;
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

/** Resolve or reject with an in-flight promise, but stop waiting on abort. */
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * A hard call ceiling for one match. `spend()` returns false rather than
 * throwing so the caller can record which stage hit the ceiling and return a
 * resumable result.
 *
 * @param {{ maxCalls?: number }} [options]
 */
export function createCallBudget({ maxCalls = DEFAULT_MAX_CALLS } = {}) {
  const max = Number(maxCalls);
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError(`maxCalls must be a positive integer, got ${String(maxCalls)}`);
  }
  let used = 0;
  return {
    get used() {
      return used;
    },
    get max() {
      return max;
    },
    get remaining() {
      return max - used;
    },
    spend() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One provider call with bounded retries for the failures the router marks
 * retryable. Only the first attempt is free of classification work; a missing
 * credential is never retried, because it will not fix itself.
 *
 * @returns {Promise<{ ok: true, text: string, attempts: number } | {
 *   ok: false, kind: string, message: string, attempts: number, cancelled?: boolean
 * }>}
 */
async function callModel({
  completeFn,
  config,
  modelId,
  prompt,
  system,
  maxTokens,
  opts,
  budget,
  maxRetries,
  retryDelayMs,
  sleep,
  signal,
}) {
  let attempts = 0;
  let lastKind = null;
  let lastMessage = "";

  while (attempts <= maxRetries) {
    throwIfAborted(signal);

    if (!budget.spend()) {
      return {
        ok: false,
        kind: STAGE_FAILURE.BUDGET,
        message: `call budget of ${budget.max} exhausted before the call`,
        attempts,
      };
    }
    attempts += 1;

    let text;
    try {
      const response = await withAbort(
        completeFn(config, modelId, prompt, {
          ...opts,
          system,
          maxTokens,
        }),
        signal,
      );
      text = typeof response?.text === "string" ? response.text : response?.output ?? "";
    } catch (err) {
      if (err?.name === "AbortError" || err?.cancelled) throw abortError(signal?.reason);
      lastKind = classifyFailure(err);
      lastMessage = err?.message ?? String(err);
      const retryable = dispositionFor(lastKind).retryable;
      if (retryable && attempts <= maxRetries) {
        await sleep(retryDelayMs * 2 ** (attempts - 1));
        continue;
      }
      return { ok: false, kind: lastKind, message: lastMessage, attempts };
    }

    if (typeof text !== "string" || !text.trim()) {
      lastKind = "empty";
      lastMessage = "provider returned an empty response";
      if (attempts <= maxRetries) {
        await sleep(retryDelayMs * 2 ** (attempts - 1));
        continue;
      }
      return { ok: false, kind: lastKind, message: lastMessage, attempts };
    }

    return { ok: true, text, attempts };
  }

  return {
    ok: false,
    kind: lastKind ?? STAGE_FAILURE.INVALID,
    message: lastMessage || "no attempts were made",
    attempts,
  };
}

/**
 * Call, parse, and validate one structured stage. `parse` turns raw text into
 * a value (or an error), and `validate` checks the value's shape. Both are
 * plain functions so a model that returns prose is retried exactly like a
 * model that timed out -- with the same budget and the same ceiling.
 */
async function runStructuredStage({
  label,
  side,
  completeFn,
  config,
  modelId,
  prompt,
  system,
  maxTokens,
  opts,
  budget,
  maxRetries,
  retryDelayMs,
  sleep,
  signal,
  parse = (text) => parseModelJson(text, label),
  validate,
}) {
  let attempts = 0;
  let lastError = null;
  let lastKind = null;

  while (attempts <= maxRetries) {
    const called = await callModel({
      completeFn,
      config,
      modelId,
      prompt,
      system,
      maxTokens,
      opts,
      budget,
      maxRetries: 0,
      retryDelayMs,
      sleep,
      signal,
    });
    attempts += 1;

    if (!called.ok) {
      const failed = /** @type {{ kind: string; message: string; cancelled?: boolean }} */ (called);
      lastKind = failed.kind;
      lastError = failed.message;
      const retryable =
        failed.kind === STAGE_FAILURE.BUDGET ? false : dispositionFor(failed.kind).retryable;
      if (retryable && attempts <= maxRetries) {
        await sleep(retryDelayMs * 2 ** (attempts - 1));
        continue;
      }
      return {
        ok: false,
        stage: label,
        side,
        kind: failed.kind,
        errors: [`${label}${side ? `/${side}` : ""}: ${failed.message}`],
        attempts,
      };
    }

    const parsed = parse(called.text);
    if (!parsed.ok) {
      const failed = /** @type {{ ok: false; error: string }} */ (parsed);
      lastKind = STAGE_FAILURE.INVALID;
      lastError = failed.error;
      if (attempts <= maxRetries) {
        await sleep(retryDelayMs * 2 ** (attempts - 1));
        continue;
      }
      return {
        ok: false,
        stage: label,
        side,
        kind: lastKind,
        errors: [`${label}${side ? `/${side}` : ""}: ${failed.error}`],
        attempts,
      };
    }

    const checked = validate(parsed.value);
    if (!checked.valid) {
      lastKind = STAGE_FAILURE.INVALID;
      lastError = checked.errors.join("; ");
      if (attempts <= maxRetries) {
        await sleep(retryDelayMs * 2 ** (attempts - 1));
        continue;
      }
      return {
        ok: false,
        stage: label,
        side,
        kind: lastKind,
        errors: checked.errors.map(
          (error) => `${label}${side ? `/${side}` : ""}: ${error}`,
        ),
        attempts,
      };
    }

    return {
      ok: true,
      stage: label,
      side,
      value: parsed.value,
      text: called.text,
      attempts,
    };
  }

  return {
    ok: false,
    stage: label,
    side,
    kind: lastKind ?? STAGE_FAILURE.INVALID,
    errors: [`${label}${side ? `/${side}` : ""}: ${lastError ?? "no attempts were made"}`],
    attempts,
  };
}

function renderAttackLine(attack, index, defense) {
  const verified = attack.evidence.kind !== "ALLEGATION";
  const tag = verified ? "verified" : "UNVERIFIED ALLEGATION";
  const lines = [
    `[${index}] ${attack.severity} on ${attack.criterion} (${tag} ${attack.evidence.kind}): ${attack.claim}`,
    `    evidence: ${attack.evidence.payload || "(none)"}`,
  ];
  if (defense) {
    lines.push(`    defense: ${defense.stance} -- ${defense.explanation}`);
  }
  return lines.join("\n");
}

/**
 * The debate record appended to the judge prompt. The judge needs the attacks
 * and the defenses to know what "survived", but the raw proposals stay in the
 * artifact store -- this is only the part the decision depends on.
 */
export function renderDebateRecord({ matchId, attacks, defenses }) {
  const lines = [`Debate record for ${matchId}:`];
  for (const side of SIDES) {
    const against = side === "candidate_a" ? "candidate_b" : "candidate_a";
    const raw = attacks?.[against];
    const list = Array.isArray(raw) ? raw : raw?.attacks ?? [];
    const answers = defenses?.[side] ?? [];
    lines.push(`Attacks by ${against} against ${side}:`);
    if (!list.length) {
      lines.push("  (none)");
    } else {
      list.forEach((attack, index) => {
        lines.push(renderAttackLine(attack, index, answers[index]));
      });
    }
  }
  return lines.join("\n");
}

function candidateId(candidate) {
  if (typeof candidate === "string") return candidate;
  return candidate?.id ?? null;
}

function candidateProposal(candidate) {
  return candidate?.proposal ?? candidate?.text ?? "";
}

function readResumed(resume, stage, side) {
  const artifact = resume?.artifacts?.[stage]?.[side];
  return isPlainObject(artifact) ? artifact : null;
}

/**
 * Run one match end to end.
 *
 * @param {object} input
 * @param {string} [input.task]
 * @param {{ id: string, a: string, b: string }} [input.match]
 * @param {{ a: object, b: object }} [input.candidates]  { id, model, proposal, card? }
 * @param {Function} [input.completeFn]                 gateway complete(config, modelId, prompt, opts)
 * @param {string} [input.judgeModel]                   model used for the independent judge
 * @param {object} [input.config]
 * @param {Function} [input.judgeCompleteFn]          defaults to completeFn
 * @param {number} [input.maxAttacks]
 * @param {number} [input.maxCalls]
 * @param {number} [input.maxRetries]
 * @param {number} [input.retryDelayMs]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.temperature]
 * @param {object} [input.tokens]                     per-stage maxTokens overrides
 * @param {AbortSignal} [input.signal]
 * @param {object} [input.resume]                     { artifacts } from a previous attempt
 * @param {Function} [input.sleep]
 * @param {Function} [input.now]
 * @param {Function} [input.onStage]                  awaited after each successful stage
 * @returns {Promise<object>}
 */
export async function runMatch({
  task,
  match,
  candidates,
  completeFn,
  judgeModel,
  config = null,
  judgeCompleteFn = null,
  maxAttacks = 1,
  maxCalls = DEFAULT_MAX_CALLS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = undefined,
  temperature = undefined,
  tokens = {},
  signal = null,
  resume = null,
  sleep = defaultSleep,
  now = () => Date.now(),
  onStage = null,
} = {}) {
  const clock = typeof now === "function" ? now : () => now;
  const startedAt = new Date(clock()).toISOString();
  const artifacts = {
    attacks: {},
    defenses: {},
    revisions: {},
    judge: null,
  };
  const errors = [];
  const failures = [];

  let budget;
  try {
    budget = createCallBudget({ maxCalls });
  } catch (err) {
    return {
      ok: false,
      status: MATCH_STATUS.FAILED,
      matchId: match?.id ?? null,
      decision: null,
      matchResult: null,
      artifacts,
      errors: [err.message],
      failures: [],
      calls: { used: 0, max: null },
      cancelled: false,
      startedAt,
      completedAt: new Date(clock()).toISOString(),
    };
  }

  const result = (patch) => ({
    ok: patch.ok ?? false,
    status: patch.status,
    matchId: match?.id ?? null,
    decision: patch.decision ?? null,
    matchResult: patch.matchResult ?? null,
    artifacts,
    errors,
    failures,
    calls: { used: budget.used, max: budget.max },
    cancelled: patch.cancelled ?? false,
    startedAt,
    completedAt: new Date(clock()).toISOString(),
  });

  const stop = (stage, side, failure) => {
    const entry = {
      stage,
      side: side ?? null,
      kind: failure.kind ?? STAGE_FAILURE.INVALID,
      message: (failure.errors ?? [failure.message ?? "stage failed"]).join("; "),
    };
    failures.push(entry);
    for (const error of failure.errors ?? [entry.message]) errors.push(error);
    return result({ status: MATCH_STATUS.FAILED });
  };

  const idA = candidateId(candidates?.a);
  const idB = candidateId(candidates?.b);
  if (!nonEmpty(task)) return { ...result({ status: MATCH_STATUS.FAILED }), errors: ["task is required"] };
  if (!isPlainObject(match) || !nonEmpty(match.id)) {
    return { ...result({ status: MATCH_STATUS.FAILED }), errors: ["match.id is required"] };
  }
  if (match.a === match.b) {
    return {
      ...result({ status: MATCH_STATUS.FAILED }),
      errors: ["a candidate cannot be matched against itself"],
    };
  }
  if (idA !== match.a || idB !== match.b) {
    return {
      ...result({ status: MATCH_STATUS.FAILED }),
      errors: [`candidates must line up with the match: expected ${match.a}/${match.b}, got ${String(idA)}/${String(idB)}`],
    };
  }
  if (typeof completeFn !== "function") {
    return { ...result({ status: MATCH_STATUS.FAILED }), errors: ["a completeFn() function is required"] };
  }
  if (typeof judgeCompleteFn !== "function" && judgeCompleteFn !== null) {
    return { ...result({ status: MATCH_STATUS.FAILED }), errors: ["judgeCompleteFn must be a function when supplied"] };
  }
  if (!nonEmpty(judgeModel)) {
    // A competitor judging its own match is not a tournament. Refuse rather
    // than silently substituting a candidate model.
    return { ...result({ status: MATCH_STATUS.FAILED }), errors: ["judgeModel is required"] };
  }

  const ids = { candidate_a: match.a, candidate_b: match.b };
  const proposals = {
    candidate_a: candidateProposal(candidates?.a),
    candidate_b: candidateProposal(candidates?.b),
  };
  for (const side of SIDES) {
    if (!nonEmpty(proposals[side])) {
      return {
        ...result({ status: MATCH_STATUS.FAILED }),
        errors: [`${ids[side]} has no proposal to compete with`],
      };
    }
  }
  const models = {
    candidate_a: candidates?.a?.model ?? null,
    candidate_b: candidates?.b?.model ?? null,
  };
  for (const side of SIDES) {
    if (!nonEmpty(models[side])) {
      return {
        ...result({ status: MATCH_STATUS.FAILED }),
        errors: [`${ids[side]} has no model configured`],
      };
    }
  }
  const cards = {
    candidate_a: candidates?.a?.card ?? null,
    candidate_b: candidates?.b?.card ?? null,
  };
  const judgeFn = judgeCompleteFn ?? completeFn;
  const tokenLimit = { ...DEFAULT_TOKENS, ...tokens };
  const opts = {
    ...(timeoutMs == null ? {} : { timeoutMs }),
    ...(temperature == null ? {} : { temperature }),
  };
  const common = {
    config,
    opts,
    budget,
    maxRetries,
    retryDelayMs,
    sleep,
    signal,
  };

  try {
    // --- attacks ---------------------------------------------------------
    const attacks = { candidate_a: null, candidate_b: null };
    for (const attacker of SIDES) {
      const target = otherSide(attacker);
      const reused = readResumed(resume, "attacks", attacker);
      if (reused) {
        const check = validateAttackResponse(reused.report, {
          matchId: match.id,
          attacker,
          target,
          maxAttacks,
        });
        if (check.valid) {
          attacks[attacker] = reused.report;
          artifacts.attacks[attacker] = { text: reused.text ?? "", report: reused.report, replayed: true };
          continue;
        }
      }

      const outcome = await runStructuredStage({
        ...common,
        label: "attack",
        side: attacker,
        completeFn,
        modelId: models[attacker],
        prompt: buildAttackPrompt({
          task,
          matchId: match.id,
          attacker: ids[attacker],
          target: ids[target],
          attackerCard: cards[attacker],
          attackerLabel: attacker,
          targetProposal: proposals[target],
          maxAttacks,
        }),
        system: ATTACK_SYSTEM_PROMPT,
        maxTokens: tokenLimit.attack,
        validate: (value) =>
          validateAttackResponse(value, {
            matchId: match.id,
            attacker,
            target,
            maxAttacks,
          }),
      });
      if (!outcome.ok) {
        if (outcome.cancelled) return result({ status: MATCH_STATUS.CANCELLED, cancelled: true });
        return stop("attack", attacker, outcome);
      }
      attacks[attacker] = outcome.value;
      artifacts.attacks[attacker] = { text: outcome.text, report: outcome.value, attempts: outcome.attempts };
      await onStage?.({ stage: "attack", side: attacker, artifact: artifacts.attacks[attacker] });
    }

    // --- defenses --------------------------------------------------------
    const defenses = { candidate_a: [], candidate_b: [] };
    for (const defender of SIDES) {
      const attacker = otherSide(defender);
      const incoming = attacks[attacker].attacks;
      const reused = readResumed(resume, "defenses", defender);
      if (reused && Array.isArray(reused.report?.responses)) {
        const check = validateDefenseResponse(reused.report, {
          matchId: match.id,
          defender,
          attackCount: incoming.length,
        });
        if (check.valid) {
          defenses[defender] = reused.report.responses;
          artifacts.defenses[defender] = { text: reused.text ?? "", report: reused.report, replayed: true };
          continue;
        }
      }

      const outcome = await runStructuredStage({
        ...common,
        label: "defense",
        side: defender,
        completeFn,
        modelId: models[defender],
        prompt: buildDefensePrompt({
          task,
          matchId: match.id,
          defender: ids[defender],
          defenderLabel: defender,
          ownProposal: proposals[defender],
          attacks: incoming,
        }),
        system: DEFENSE_SYSTEM_PROMPT,
        maxTokens: tokenLimit.defense,
        validate: (value) =>
          validateDefenseResponse(value, {
            matchId: match.id,
            defender,
            attackCount: incoming.length,
          }),
      });
      if (!outcome.ok) {
        if (outcome.cancelled) return result({ status: MATCH_STATUS.CANCELLED, cancelled: true });
        return stop("defense", defender, outcome);
      }
      defenses[defender] = outcome.value.responses;
      artifacts.defenses[defender] = { text: outcome.text, report: outcome.value, attempts: outcome.attempts };
      await onStage?.({ stage: "defense", side: defender, artifact: artifacts.defenses[defender] });
    }

    // --- revisions -------------------------------------------------------
    const revised = { candidate_a: proposals.candidate_a, candidate_b: proposals.candidate_b };
    for (const side of SIDES) {
      const attacker = otherSide(side);
      const incoming = attacks[attacker].attacks;
      const reused = readResumed(resume, "revisions", side);
      if (reused) {
        const check = validateRevisionResponse(reused.report, { matchId: match.id, candidate: side });
        if (check.valid) {
          revised[side] = reused.report.proposal;
          artifacts.revisions[side] = { text: reused.text ?? "", report: reused.report, replayed: true };
          continue;
        }
      }

      const outcome = await runStructuredStage({
        ...common,
        label: "revision",
        side,
        completeFn,
        modelId: models[side],
        prompt: buildRevisionPrompt({
          task,
          matchId: match.id,
          candidate: ids[side],
          candidateLabel: side,
          ownProposal: proposals[side],
          attacks: incoming,
          defenses: defenses[side],
        }),
        system: REVISION_SYSTEM_PROMPT,
        maxTokens: tokenLimit.revision,
        validate: (value) => validateRevisionResponse(value, { matchId: match.id, candidate: side }),
      });
      if (!outcome.ok) {
        if (outcome.cancelled) return result({ status: MATCH_STATUS.CANCELLED, cancelled: true });
        return stop("revision", side, outcome);
      }
      revised[side] = outcome.value.proposal;
      artifacts.revisions[side] = { text: outcome.text, report: outcome.value, attempts: outcome.attempts };
      await onStage?.({ stage: "revision", side, artifact: artifacts.revisions[side] });
    }

    // --- judge -----------------------------------------------------------
    const judgePrompt = [
      buildJudgePrompt({
        task,
        matchId: match.id,
        candidateA: { id: ids.candidate_a, proposal: revised.candidate_a, cardId: cards.candidate_a?.id },
        candidateB: { id: ids.candidate_b, proposal: revised.candidate_b, cardId: cards.candidate_b?.id },
      }),
      renderDebateRecord({ matchId: match.id, attacks, defenses }),
    ].join("\n\n");

    let judged = null;
    const reusedJudge = resume?.artifacts?.judge;
    if (isPlainObject(reusedJudge) && isPlainObject(reusedJudge.report)) {
      const check = decideMatch(reusedJudge.report, {
        matchId: match.id,
        candidateA: ids.candidate_a,
        candidateB: ids.candidate_b,
        now: clock(),
      });
      // An unresolved decision is not a result worth replaying: a resume with a
      // different judge should actually ask the new judge. Only a winner is
      // cached.
      if (check.ok && check.decision.outcome === "winner") {
        judged = { ...check, text: reusedJudge.text ?? "", replayed: true, attempts: 0 };
        artifacts.judge = {
          text: reusedJudge.text ?? "",
          report: reusedJudge.report,
          replayed: true,
        };
      }
    }

    if (!judged) {
      const outcome = await runStructuredStage({
        ...common,
        label: "judge",
        side: null,
        completeFn: judgeFn,
        modelId: judgeModel,
        prompt: judgePrompt,
        system: JUDGE_SYSTEM_PROMPT,
        maxTokens: tokenLimit.judge,
        parse: parseJudgeJson,
        validate: (value) => {
          const check = decideMatch(value, {
            matchId: match.id,
            candidateA: ids.candidate_a,
            candidateB: ids.candidate_b,
            now: clock(),
          });
          return check.ok ? { valid: true, errors: [] } : { valid: false, errors: check.errors };
        },
      });
      if (!outcome.ok) {
        if (outcome.cancelled) return result({ status: MATCH_STATUS.CANCELLED, cancelled: true });
        return stop("judge", null, outcome);
      }

      const check = decideMatch(outcome.value, {
        matchId: match.id,
        candidateA: ids.candidate_a,
        candidateB: ids.candidate_b,
        now: clock(),
      });
      if (!check.ok) {
        // runStructuredStage already validated; this is a guard against a
        // future divergence between validation and decision.
        return stop("judge", null, { kind: STAGE_FAILURE.INVALID, errors: check.errors });
      }
      judged = { ...check, text: outcome.text, replayed: false, attempts: outcome.attempts };
      artifacts.judge = {
        text: outcome.text,
        report: outcome.value,
        attempts: outcome.attempts,
      };
      await onStage?.({ stage: "judge", side: null, artifact: artifacts.judge });
    }

    if (judged.decision.outcome === "unresolved") {
      return result({ ok: true, status: MATCH_STATUS.UNRESOLVED, decision: judged.decision });
    }
    return result({
      ok: true,
      status: MATCH_STATUS.DECIDED,
      decision: judged.decision,
      matchResult: decisionToMatchResult(judged.decision),
    });
  } catch (err) {
    if (err?.name === "AbortError" || err?.cancelled) {
      return result({ status: MATCH_STATUS.CANCELLED, cancelled: true });
    }
    failures.push({ stage: "internal", side: null, kind: "unexpected", message: err?.message ?? String(err) });
    errors.push(`match ${match.id} failed unexpectedly: ${err?.message ?? String(err)}`);
    return result({ status: MATCH_STATUS.FAILED });
  }
}

/**
 * How many calls a tournament is expected to make. Single elimination always
 * plays exactly (alive - 1) real matches from any point in the bracket, and a
 * bye costs nothing, so this stays correct for the current round and for the
 * rounds that have not been paired yet.
 *
 * @param {object} state tournament state
 * @returns {{ alive: number, matches: number, calls: number }}
 */
export function estimateTournamentCalls(state) {
  const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
  const alive = candidates.filter(
    (candidate) => candidate.status === "alive" || candidate.status === "champion",
  ).length;
  const matches = Math.max(0, alive - 1);
  return { alive, matches, calls: matches * BASE_MATCH_CALLS };
}

export default {
  BASE_MATCH_CALLS,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  MATCH_STATUS,
  STAGE_FAILURE,
  createCallBudget,
  renderDebateRecord,
  runMatch,
  estimateTournamentCalls,
};
