// Probe-target selection for `aflow doctor` and `aflow dashboard`.
//
// The bug these guard against is subtle: the gateway treats an unrecognised
// `<prefix>/<model>` id as a local model name, so a hard-coded candidate that
// names a provider this build does not serve is silently sent to Ollama. The
// probe then fails with "model not found", which reads like a provider outage
// and has nothing to do with the user's credentials.
//
// So the assertion is not "the list has these strings" but "every string routes
// to the provider it names".

import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS, resolveTargetProvider } from "../src/core/gateway-server.js";
import { defaultProbeCandidates, MAX_DEFAULT_PROBES } from "../src/core/probe-candidates.js";

test("no configured providers means nothing to probe", () => {
  assert.deepEqual(defaultProbeCandidates({}), []);
});

test("one configured provider yields one model that actually routes to it", () => {
  const env = { GROQ_API_KEY: "k" };
  const candidates = defaultProbeCandidates(env);

  assert.deepEqual(candidates, [`groq/${PROVIDERS.groq.models[0]}`]);
  const target = resolveTargetProvider(candidates[0], env);
  assert.equal(target.provider, "groq");
  assert.equal(target.local, false);
});

test("every candidate resolves to the non-local provider it names", () => {
  const env = {
    GROQ_API_KEY: "k",
    CEREBRAS_API_KEY: "k",
    MISTRAL_API_KEY: "k",
    GEMINI_API_KEY: "k",
    OPENROUTER_API_KEY: "k",
  };
  const candidates = defaultProbeCandidates(env, PROVIDERS, 99);

  assert.equal(candidates.length, 5);
  for (const id of candidates) {
    const prefix = id.slice(0, id.indexOf("/"));
    assert.ok(PROVIDERS[prefix], `${id} names a provider that does not exist`);
    const target = resolveTargetProvider(id, env);
    assert.equal(target.provider, prefix, `${id} must not fall back to another provider`);
    assert.equal(target.local, false, `${id} must not fall back to local Ollama`);
  }
});

test("the stale aliases that used to be hard-coded are never produced", () => {
  const env = {
    GROQ_API_KEY: "k",
    CEREBRAS_API_KEY: "k",
    MISTRAL_API_KEY: "k",
    GEMINI_API_KEY: "k",
    OPENROUTER_API_KEY: "k",
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ACCOUNT_ID: "a",
    HF_TOKEN: "t",
    TOGETHER_API_KEY: "k",
    FIREWORKS_API_KEY: "k",
    DEEPINFRA_API_KEY: "k",
    SAMBANOVA_API_KEY: "k",
  };
  const candidates = defaultProbeCandidates(env, PROVIDERS, 99);
  assert.ok(candidates.length >= MAX_DEFAULT_PROBES);
  for (const id of candidates) {
    assert.doesNotMatch(id, /^(oc|ocz|bzl)\//);
  }
});

test("selection is capped so doctor stays quick", () => {
  const env = {
    GROQ_API_KEY: "k",
    CEREBRAS_API_KEY: "k",
    MISTRAL_API_KEY: "k",
    GEMINI_API_KEY: "k",
  };
  assert.equal(defaultProbeCandidates(env).length, MAX_DEFAULT_PROBES);

  const shorter = defaultProbeCandidates(env, PROVIDERS, 2);
  assert.equal(shorter.length, 2);
  assert.deepEqual(shorter, defaultProbeCandidates(env).slice(0, 2));
});

test("a multi-key provider is only probed when both keys are present", () => {
  const partial = defaultProbeCandidates({ CLOUDFLARE_API_TOKEN: "t" }, PROVIDERS, 99);
  assert.equal(partial.some((id) => id.startsWith("cloudflare/")), false);

  const full = defaultProbeCandidates(
    { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" },
    PROVIDERS,
    99,
  );
  assert.equal(full.some((id) => id.startsWith("cloudflare/")), true);
});

test("local providers are never probed", () => {
  const candidates = defaultProbeCandidates({ OLLAMA_API_KEY: "k" }, PROVIDERS, 99);
  assert.equal(candidates.some((id) => id.startsWith("ollama/")), false);
});
