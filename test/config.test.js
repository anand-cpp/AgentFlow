// Config precedence tests.
//
// The precedence chain is a documented contract (see `aflow config --help`),
// so it gets tested rather than trusted.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, DEFAULTS, projectConfigPaths } from "../src/config/index.js";

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${label}-`));
}

test("defaults apply when nothing else is set", () => {
  const { config } = resolveConfig({ flags: {}, env: {}, cwd: os.tmpdir() });
  assert.equal(config.baseUrl, DEFAULTS.baseUrl);
  assert.equal(config.theme, DEFAULTS.theme);
});

test("flags beat everything", () => {
  // Documented precedence: defaults < global < project < env < flags.
  const dir = tmpdir("flags");
  fs.writeFileSync(path.join(dir, ".agentflow.json"), JSON.stringify({ baseUrl: "http://from-project:1" }));
  const { config } = resolveConfig({
    flags: { "base-url": "http://from-flag:5555" },
    env: { AGENTFLOW_BASE_URL: "http://from-env:2222" },
    cwd: dir,
  });
  assert.equal(config.baseUrl, "http://from-flag:5555");
});

test("flags beat defaults", () => {
  const { config } = resolveConfig({ flags: { port: "9999" }, env: {}, cwd: os.tmpdir() });
  assert.equal(config.baseUrl, "http://localhost:9999");
});

test("environment beats project config", () => {
  // Documented precedence: defaults < global < project < env < flags.
  const dir = tmpdir("proj");
  fs.writeFileSync(
    path.join(dir, ".agentflow.json"),
    JSON.stringify({ baseUrl: "http://from-project:3333" })
  );
  const { config } = resolveConfig({
    flags: {},
    env: { AGENTFLOW_BASE_URL: "http://from-env:4444" },
    cwd: dir,
  });
  assert.equal(config.baseUrl, "http://from-env:4444");
});

test("nearest project config wins over an outer one", () => {
  const root = tmpdir("nested");
  const nested = path.join(root, "sub");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, ".agentflow.json"), JSON.stringify({ theme: "outer" }));
  fs.writeFileSync(path.join(nested, ".agentflow.json"), JSON.stringify({ theme: "inner" }));

  const { config } = resolveConfig({ flags: {}, env: {}, cwd: nested });
  assert.equal(config.theme, "inner", "closest config must have the last word");
});

test("boolean env vars parse correctly", () => {
  for (const [raw, expected] of [["true", true], ["1", true], ["yes", true], ["false", false], ["0", false]]) {
    const { config } = resolveConfig({ flags: {}, env: { AGENTFLOW_JSON: raw }, cwd: os.tmpdir() });
    assert.equal(config.json, expected, `AGENTFLOW_JSON=${raw}`);
  }
});

test("numeric env vars parse and reject garbage", () => {
  const good = resolveConfig({ flags: {}, env: { AGENTFLOW_PROBE_TIMEOUT_MS: "500" }, cwd: os.tmpdir() });
  assert.equal(good.config.probeTimeoutMs, 500);

  const bad = resolveConfig({ flags: {}, env: { AGENTFLOW_PROBE_TIMEOUT_MS: "abc" }, cwd: os.tmpdir() });
  assert.equal(bad.config.probeTimeoutMs, DEFAULTS.probeTimeoutMs, "garbage must not override the default");
});

test("project config is discovered by walking up", () => {
  const root = tmpdir("walk");
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, ".agentflow.json"), JSON.stringify({ theme: "solarized" }));

  const found = projectConfigPaths(nested);
  assert.equal(found.length, 1);
  assert.equal(found[0], path.join(root, ".agentflow.json"));
});

test("nearest project config is found first", () => {
  const root = tmpdir("near");
  const nested = path.join(root, "sub");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, ".agentflow.json"), JSON.stringify({ theme: "outer" }));
  fs.writeFileSync(path.join(nested, ".agentflow.json"), JSON.stringify({ theme: "inner" }));

  const found = projectConfigPaths(nested);
  assert.equal(found[0], path.join(nested, ".agentflow.json"), "nearest must come first");
});

test("malformed project config is reported but not fatal", () => {
  const dir = tmpdir("bad");
  const file = path.join(dir, ".agentflow.json");
  fs.writeFileSync(file, "{ not json");
  const { config, diagnostics } = resolveConfig({ flags: {}, env: {}, cwd: dir });
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].includes(file), "diagnostic must name the offending file");
  assert.equal(config.baseUrl, DEFAULTS.baseUrl, "must still resolve");
});

test("unrecognised boolean env value falls back to the default", () => {
  // `AGENTFLOW_JSON=maybe` must not enable JSON output.
  const { config } = resolveConfig({ flags: {}, env: { AGENTFLOW_JSON: "maybe" }, cwd: os.tmpdir() });
  assert.equal(config.json, DEFAULTS.json);
});

test("--no-color flag reaches config.noColor", () => {
  // The parser keeps flags dashed; config keys are camelCase. A mismatch here
  // silently disabled the documented precedence chain.
  const { config } = resolveConfig({ flags: { "no-color": true }, env: {}, cwd: os.tmpdir() });
  assert.equal(config.noColor, true);
});

test("AGENTFLOW_NO_COLOR is honoured", () => {
  const { config } = resolveConfig({ flags: {}, env: { AGENTFLOW_NO_COLOR: "1" }, cwd: os.tmpdir() });
  assert.equal(config.noColor, true);
});

test("every documented env var is mapped to a real config key", () => {
  // Guards against the ENV_MAP/DEFAULTS drift that left AGENTFLOW_NO_COLOR
  // declared in DEFAULTS but unreachable from the environment.
  const samples = {
    AGENTFLOW_BASE_URL: "http://example:1",
    AGENTFLOW_API_KEY: "fixture",
    AGENTFLOW_PROBE_TIMEOUT_MS: "1234",
    AGENTFLOW_DEFAULT_MODEL: "some/model",
    AGENTFLOW_THEME: "dark",
    AGENTFLOW_JSON: "true",
    AGENTFLOW_QUIET: "true",
    AGENTFLOW_VERBOSE: "true",
    AGENTFLOW_NO_COLOR: "true",
  };
  const { config } = resolveConfig({ flags: {}, env: samples, cwd: os.tmpdir() });
  assert.equal(config.baseUrl, "http://example:1");
  assert.equal(config.apiKey, "fixture");
  assert.equal(config.probeTimeoutMs, 1234);
  assert.equal(config.defaultModel, "some/model");
  assert.equal(config.theme, "dark");
  assert.equal(config.json, true);
  assert.equal(config.quiet, true);
  assert.equal(config.verbose, true);
  assert.equal(config.noColor, true);
});

test("sources are recorded for inspection", () => {
  const dir = tmpdir("src");
  fs.writeFileSync(path.join(dir, ".agentflow.json"), JSON.stringify({ theme: "x" }));
  const { sources } = resolveConfig({ flags: { json: true }, env: {}, cwd: dir });
  assert.ok(sources.includes("flags"));
});