// The documented five-layer precedence for configuration, in one place:
// defaults < global file < project file (nearest wins) < AGENTFLOW_* env <
// CLI flags.
//
// Every layer that silently loses or silently wins here is a user-visible
// surprise ("why does my --json flag not work?"), so the ladder is asserted
// end to end rather than one pair at a time.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfig, projectConfigPaths, globalConfigPath, DEFAULTS, CONFIG_BASENAME } from "../src/config/index.js";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A private global config dir + a project dir, so no real user config leaks in. */
function sandbox(t) {
  const root = tmpdir(t);
  const globalDir = path.join(root, "global");
  const project = path.join(root, "project");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, globalDir, project, globalFile: path.join(globalDir, "config.json") };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test("defaults apply when nothing else is set", (t) => {
  const s = sandbox(t);
  const { config, sources, diagnostics } = resolveConfig({
    env: { AGENTFLOW_CONFIG_DIR: s.globalDir },
    cwd: s.project,
    flags: {},
  });

  assert.deepEqual(config, { ...DEFAULTS });
  assert.deepEqual(sources, []);
  assert.deepEqual(diagnostics, []);
  assert.equal(config.baseUrl, "http://localhost:20127");
});

test("a project file overrides a global file, and layers merge shallowly", (t) => {
  const s = sandbox(t);
  writeJson(s.globalFile, { theme: "dark", baseUrl: "http://global", quiet: true });
  const projectFile = path.join(s.project, CONFIG_BASENAME);
  writeJson(projectFile, { baseUrl: "http://project" });

  const { config, sources } = resolveConfig({
    env: { AGENTFLOW_CONFIG_DIR: s.globalDir },
    cwd: s.project,
    flags: {},
  });

  assert.equal(config.baseUrl, "http://project", "the nearer file has the last word");
  assert.equal(config.theme, "dark", "a key the project never set survives the merge");
  assert.equal(config.quiet, true, "an unrelated global key is not erased");

  assert.ok(sources.includes(s.globalFile));
  assert.ok(sources.includes(projectFile));
  assert.ok(sources.indexOf(s.globalFile) < sources.indexOf(projectFile), "global is applied first");
});

test("the nearest project file wins when several sit on the walk up", (t) => {
  const s = sandbox(t);
  const outer = path.join(s.root, "outer");
  const inner = path.join(outer, "a", "b");
  fs.mkdirSync(inner, { recursive: true });
  writeJson(path.join(outer, CONFIG_BASENAME), { baseUrl: "http://outer" });
  writeJson(path.join(inner, CONFIG_BASENAME), { baseUrl: "http://inner" });

  const { config } = resolveConfig({
    env: { AGENTFLOW_CONFIG_DIR: s.globalDir },
    cwd: inner,
    flags: {},
  });

  assert.equal(config.baseUrl, "http://inner");

  const found = projectConfigPaths(inner, outer);
  assert.deepEqual(found, [
    path.join(inner, CONFIG_BASENAME),
    path.join(outer, CONFIG_BASENAME),
  ], "nearest first");
});

test("environment variables beat every file layer", (t) => {
  const s = sandbox(t);
  writeJson(s.globalFile, { theme: "dark" });
  writeJson(path.join(s.project, CONFIG_BASENAME), { theme: "solarized", serverPort: 1111 });

  const { config, sources } = resolveConfig({
    env: {
      AGENTFLOW_CONFIG_DIR: s.globalDir,
      AGENTFLOW_THEME: "light",
      AGENTFLOW_SERVER_PORT: "3000",
      AGENTFLOW_LOG_LEVEL: "debug",
    },
    cwd: s.project,
    flags: {},
  });

  assert.equal(config.theme, "light");
  assert.equal(config.serverPort, 3000, "numeric env values are parsed, not left as strings");
  assert.equal(config.logLevel, "debug");
  assert.ok(sources.includes("environment"));
});

test("flags beat environment, completing the full precedence ladder", (t) => {
  const s = sandbox(t);
  writeJson(s.globalFile, { theme: "dark", baseUrl: "http://global", json: false });
  writeJson(path.join(s.project, CONFIG_BASENAME), { theme: "solarized", baseUrl: "http://project", quiet: true });

  const { config, sources } = resolveConfig({
    env: {
      AGENTFLOW_CONFIG_DIR: s.globalDir,
      AGENTFLOW_JSON: "false",
      AGENTFLOW_BASE_URL: "http://env",
      AGENTFLOW_THEME: "light",
    },
    cwd: s.project,
    flags: { json: true, model: "mistral/model", port: 9999 },
  });

  // flags > env > project > global > defaults, one assertion per hop.
  assert.equal(config.json, true, "flags beat env (env said false)");
  assert.equal(config.baseUrl, "http://localhost:9999", "the --port flag beats env and every file");
  assert.equal(config.defaultModel, "mistral/model", "flags set model directly");
  assert.equal(config.theme, "light", "env beats project beats global");
  assert.equal(config.quiet, true, "project key with no higher layer survives");
  assert.ok(sources.includes("flags"));
});

test("a malformed config file is reported and lower layers still load", (t) => {
  const s = sandbox(t);
  writeJson(s.globalFile, { theme: "dark" });
  fs.writeFileSync(path.join(s.project, CONFIG_BASENAME), '{"theme": "broken');

  const { config, diagnostics } = resolveConfig({
    env: { AGENTFLOW_CONFIG_DIR: s.globalDir },
    cwd: s.project,
    flags: {},
  });

  assert.equal(diagnostics.length, 1, "the parse error is surfaced");
  assert.ok(diagnostics[0].includes(CONFIG_BASENAME));
  assert.equal(config.theme, "dark", "a broken project file does not make the CLI unusable");
});

test("unrecognised boolean env input falls back instead of becoming true", (t) => {
  const s = sandbox(t);

  const on = resolveConfig({ env: { AGENTFLOW_CONFIG_DIR: s.globalDir, AGENTFLOW_JSON: "maybe" }, cwd: s.project });
  assert.equal(on.config.json, false, "'maybe' is not a boolean");

  const truthy = resolveConfig({ env: { AGENTFLOW_CONFIG_DIR: s.globalDir, AGENTFLOW_QUIET: "on" }, cwd: s.project });
  assert.equal(truthy.config.quiet, true);

  const falsy = resolveConfig({ env: { AGENTFLOW_CONFIG_DIR: s.globalDir, AGENTFLOW_VERBOSE: "0" }, cwd: s.project });
  assert.equal(falsy.config.verbose, false);
});

test("an unrelated AGENTFLOW_* variable is ignored by the env layer", (t) => {
  const s = sandbox(t);

  const { config, sources } = resolveConfig({
    env: { AGENTFLOW_CONFIG_DIR: s.globalDir, AGENTFLOW_NOT_A_SETTING: "x" },
    cwd: s.project,
    flags: {},
  });

  assert.deepEqual(sources, [], "unmapped variables do not become config keys");
  assert.equal(/** @type {any} */ (config).NOT_A_SETTING, undefined);
  assert.equal(globalConfigPath().endsWith("config.json"), true);
});
