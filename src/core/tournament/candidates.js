// Candidate generation for Arena.
//
// A tournament needs N independent proposals before it can pair anyone. This
// module turns a tournament's dealt strategy cards into those proposals with one
// model call per candidate, and nothing else. It is separate from the bracket
// driver because generation is the part that costs money before a single match
// is played: the CLI estimates it, asks for confirmation, and only then calls
// this.
//
// Proposals are plain text, not JSON. A proposal is prose by nature, and asking
// a model to escape a long plan into a JSON string is a reliable way to get
// truncated output. The only contract is "non-empty text".

import { createCallBudget } from "./match.js";

/** One generation call per candidate. */
export function estimateGenerationCalls(candidates) {
  return Array.isArray(candidates) ? candidates.length : 0;
}

function renderCard(card) {
  if (!card) return "(no strategy card)";
  return [
    `reasoning: ${card.reasoning ?? ""}`,
    `workflow: ${card.workflow ?? ""}`,
    `optimization: ${card.optimization ?? ""}`,
  ].join("\n");
}

/**
 * Prompt for one candidate's proposal. The strategy card is the only thing that
 * differentiates two candidates on the same model, so it is stated plainly
 * rather than left as a label.
 *
 * @param {{ task: string, candidateId: string, card?: object }} input
 */
export function buildGenerationPrompt({ task, candidateId, card = null } = {}) {
  return [
    `Task:\n${String(task ?? "").trim()}`,
    `You are candidate ${candidateId} in a competitive evaluation. Produce the strongest complete answer to the task you can.`,
    `Your strategy card (follow it):\n${renderCard(card)}`,
    "Be specific and directly usable: name files, functions, commands, and concrete steps where the task calls for them.",
    "Do not describe a tournament, do not address other candidates, and do not mention this prompt.",
    "Reply with the proposal text only -- no preamble, no markdown fences.",
  ].join("\n\n");
}

export const GENERATION_SYSTEM_PROMPT = [
  "You are one contender in a competitive evaluation.",
  "Answer the task itself, in full. Do not discuss the competition, the rubric, or your own process.",
  "Prefer concrete, correct, complete work over length.",
].join("\n");

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(reason) {
  const err = new Error(typeof reason === "string" && reason ? reason : "arena generation cancelled");
  err.name = "AbortError";
  err.cancelled = true;
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

async function withAbort(promise, signal) {
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
 * Generate one proposal per candidate, bounded by `maxCalls` and retries.
 *
 * A failed generation is returned as a failure for that candidate; the caller
 * decides whether to abandon the run. It never substitutes a placeholder
 * proposal, because a tournament between placeholder answers decides nothing.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {Array<{ id: string, model: string, card?: object }>} input.candidates
 * @param {Function} input.completeFn
 * @param {object} [input.config]
 * @param {number} [input.maxRetries]
 * @param {number} [input.retryDelayMs]
 * @param {number} [input.maxCalls]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.temperature]
 * @param {number} [input.maxTokens]
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.sleep]
 * @param {Function} [input.onCandidate]  awaited after each successful proposal
 */
export async function generateCandidates({
  task,
  candidates = [],
  completeFn,
  config = null,
  maxRetries = 1,
  retryDelayMs = 250,
  maxCalls = candidates.length,
  timeoutMs = undefined,
  temperature = undefined,
  maxTokens = 2000,
  signal = null,
  sleep = defaultSleep,
  onCandidate = null,
} = {}) {
  if (typeof completeFn !== "function") {
    return { ok: false, proposals: {}, errors: ["a completeFn() function is required"], calls: 0 };
  }
  if (!String(task ?? "").trim()) {
    return { ok: false, proposals: {}, errors: ["task is required"], calls: 0 };
  }
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    return { ok: false, proposals: {}, errors: ["no candidates to generate"], calls: 0 };
  }

  const budget = createCallBudget({ maxCalls: Math.max(1, Number(maxCalls) || list.length) });
  const proposals = {};
  const errors = [];
  const opts = {
    ...(timeoutMs == null ? {} : { timeoutMs }),
    ...(temperature == null ? {} : { temperature }),
  };

  try {
    for (const candidate of list) {
      const id = String(candidate?.id ?? "");
      const model = candidate?.model ?? null;
      if (!id) {
        errors.push("every candidate needs an id");
        continue;
      }
      if (!model) {
        errors.push(`${id} has no model configured`);
        continue;
      }

      const prompt = buildGenerationPrompt({ task, candidateId: id, card: candidate.card });
      let text = null;
      let lastError = null;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        throwIfAborted(signal);
        if (!budget.spend()) {
          errors.push(`${id}: call budget of ${budget.max} exhausted before generation`);
          break;
        }
        try {
          const response = await withAbort(
            completeFn(config, model, prompt, {
              ...opts,
              system: GENERATION_SYSTEM_PROMPT,
              maxTokens,
            }),
            signal,
          );
          const raw = typeof response?.text === "string" ? response.text : response?.output ?? "";
          if (typeof raw === "string" && raw.trim()) {
            text = raw.trim();
            break;
          }
          lastError = "provider returned an empty response";
        } catch (err) {
          if (err?.name === "AbortError" || err?.cancelled) throw err;
          lastError = err?.message ?? String(err);
        }
        if (attempt < maxRetries) await sleep(retryDelayMs * 2 ** attempt);
      }

      if (!text) {
        errors.push(`${id}: ${lastError ?? "generation failed"}`);
        continue;
      }
      proposals[id] = text;
      await onCandidate?.({ candidateId: id, model, proposal: text });
    }
  } catch (err) {
    if (err?.name === "AbortError" || err?.cancelled) {
      return { ok: false, proposals, errors: [...errors, "generation cancelled"], calls: budget.used, cancelled: true };
    }
    return {
      ok: false,
      proposals,
      errors: [...errors, `generation failed unexpectedly: ${err?.message ?? String(err)}`],
      calls: budget.used,
    };
  }

  return { ok: errors.length === 0, proposals, errors, calls: budget.used };
}

export default {
  GENERATION_SYSTEM_PROMPT,
  estimateGenerationCalls,
  buildGenerationPrompt,
  generateCandidates,
};
