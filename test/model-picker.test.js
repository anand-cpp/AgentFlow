// Model picker (src/tui/model-picker.js): grouping, ranking, and rendering.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const { buildModelItems, renderModelPicker, filterModels, createModelDialogSpec, configuredProviders } =
  await import("../src/tui/model-picker.js");

const SAMPLE = {
  groq: { label: "Groq", models: ["llama-3.3-70b", "llama-3.1-8b"], ratePerMin: 30, creditCard: false, envKeys: ["GROQ_API_KEY"] },
  ollama: { label: "Ollama", models: [], ratePerMin: null, creditCard: false, envKeys: [] },
  gemini: { label: "Google Gemini", models: ["gemini-2.0-flash"], ratePerMin: 15, creditCard: false, envKeys: ["GEMINI_API_KEY"] },
};

test("items are local-first then alphabetical and use provider/model ids", () => {
  const items = buildModelItems({ providers: SAMPLE, configured: ["groq", "ollama", "gemini"] });
  assert.equal(items[0].provider, "ollama", "the local provider leads");
  const rest = [...new Set(items.slice(1).map((i) => i.provider))];
  assert.deepEqual(rest, ["gemini", "groq"], "the rest sort alphabetically");
  assert.ok(items.some((i) => i.value === "groq/llama-3.3-70b"));
});

test("the current model is marked and rate/credit facts are surfaced", () => {
  const items = buildModelItems({ providers: SAMPLE, configured: ["groq", "ollama", "gemini"], currentModel: "groq/llama-3.3-70b" });
  const current = items.find((i) => i.value === "groq/llama-3.3-70b");
  assert.match(current.label, /^\* /, "the active model carries a bullet");
  assert.match(current.description, /30\/min/);
  assert.match(current.description, /no card/);
});

test("providers without credentials are disabled but still listed", () => {
  const items = buildModelItems({ providers: SAMPLE, configured: ["groq"] });
  const gemini = items.find((i) => i.provider === "gemini");
  assert.equal(gemini.disabled, true, "an unconfigured provider cannot be chosen");
  const groq = items.find((i) => i.provider === "groq");
  assert.equal(groq.disabled, false);
});

test("a provider with no fixed models gets a placeholder row", () => {
  const items = buildModelItems({ providers: SAMPLE, configured: ["ollama"] });
  const local = items.find((i) => i.provider === "ollama");
  assert.ok(local, "ollama is still offered");
  assert.equal(local.local, true);
});

test("rendering draws a titled box and honours the width", () => {
  const items = buildModelItems({ providers: SAMPLE, configured: ["groq", "ollama", "gemini"] });
  const out = renderModelPicker({ items, selected: 0 }, 60);
  assert.match(out, /Select model|model/);
  for (const line of out.split("\n")) assert.ok(line.length <= 62, "width respected");
});

test("fuzzy filtering narrows the model set", () => {
  const items = buildModelItems({ providers: SAMPLE, configured: ["groq", "ollama", "gemini"] });
  const filtered = filterModels(items, "flash");
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((i) => /flash/i.test(i.label + i.description + i.value)));
});

test("createModelDialogSpec returns null on an empty catalogue", () => {
  assert.equal(createModelDialogSpec({ providers: {} }), null);
  const spec = createModelDialogSpec({ providers: SAMPLE, configured: ["groq"] });
  assert.equal(spec.title, "Select model");
  assert.ok(spec.items.length > 0);
});

test("configuredProviders detects env keys and always includes the local provider", () => {
  const env = { GROQ_API_KEY: "x" };
  const set = configuredProviders(SAMPLE, env);
  assert.ok(set.has("groq"), "a present key marks the provider configured");
  assert.ok(set.has("ollama"), "the local provider needs no key");
  assert.ok(!set.has("gemini"), "a missing key leaves the provider out");
});
