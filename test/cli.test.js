// CLI argument parsing and command registry tests.

import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv } from "../src/cli/index.js";
import { defineCommand, getCommand, commandNames } from "../src/cli/registry.js";

test("extracts command name and positional args", () => {
  const r = parseArgv(["models", "gemini", "--probe"]);
  assert.equal(r.commandName, "models");
  assert.deepEqual(r.args, ["gemini"]);
  assert.equal(r.flags.probe, true);
});

test("value flags consume the next token", () => {
  const r = parseArgv(["status", "--port", "3000", "--model", "oc/x"]);
  assert.equal(r.flags.port, "3000");
  assert.equal(r.flags.model, "oc/x");
});

test("command-declared value flags consume the next token", () => {
  // Regression: the parser hardcoded which flags took values, so `--limit 4`
  // became `--limit=true` with `4` left as a stray positional. That silently
  // turned a limit of 4 into 1 and made `--type X` match nothing at all.
  const vf = new Set(["limit", "type", "since", "file", "level"]);

  let r = parseArgv(["logs", "--limit", "4"], vf);
  assert.equal(r.flags.limit, "4");
  assert.equal(r.commandName, "logs");
  assert.deepEqual(r.args, [], "the value must not leak into positionals");

  r = parseArgv(["logs", "--type", "route.fallback"], vf);
  assert.equal(r.flags.type, "route.fallback");

  r = parseArgv(["logs", "--since", "2026-01-01T00:00:00Z"], vf);
  assert.equal(r.flags.since, "2026-01-01T00:00:00Z");
});

test("boolean flags still do not swallow the next token", () => {
  const vf = new Set(["limit"]);
  const r = parseArgv(["status", "--probe", "--json"], vf);
  assert.equal(r.flags.probe, true, "--probe takes no value");
  assert.equal(r.flags.json, true);
});

test("--key=value works for value and boolean flags alike", () => {
  const vf = new Set(["limit"]);
  const r = parseArgv(["logs", "--limit=25", "--json=true"], vf);
  assert.equal(r.flags.limit, "25");
  assert.equal(r.flags.json, "true");
});

test("a value flag with nothing after it does not invent a value", () => {
  const r = parseArgv(["logs", "--limit"], new Set(["limit"]));
  assert.equal(r.flags.limit, true);
});

test("value flags are discoverable from the command registry", async () => {
  await import("../src/commands/index.js");
  const { valueFlagNames } = await import("../src/cli/registry.js");
  const vf = valueFlagNames();
  for (const expected of ["limit", "type", "since", "file", "level"]) {
    assert.ok(vf.has(expected), `${expected} should be declared as a value flag`);
  }
  // Globals stay value-taking even without a command declaring them.
  const r = parseArgv(["status", "--port", "9999"], vf);
  assert.equal(r.flags.port, "9999");
});

test("a stray positional is not eaten by a value flag", () => {
  const vf = new Set(["limit"]);
  const r = parseArgv(["models", "anthropic"], vf);
  assert.equal(r.commandName, "models");
  assert.deepEqual(r.args, ["anthropic"], "the filter must survive as a positional");
});

test("supports --key=value form", () => {
  const r = parseArgv(["status", "--base-url=http://h:1"]);
  assert.equal(r.flags["base-url"], "http://h:1");
});

test("short flags map to long names", () => {
  const r = parseArgv(["-v"]);
  assert.equal(r.flags.version, true);
});

test("boolean flags do not swallow the command name", () => {
  // Regression guard: --json before a command must not consume it.
  const r = parseArgv(["--json", "doctor"]);
  assert.equal(r.commandName, "doctor");
  assert.equal(r.flags.json, true);
});

test("double dash stops flag parsing", () => {
  const r = parseArgv(["models", "--", "--not-a-flag"]);
  assert.deepEqual(r.args, ["--not-a-flag"]);
  assert.equal(r.flags["not-a-flag"], undefined);
});

test("no args yields no command", () => {
  const r = parseArgv([]);
  assert.equal(r.commandName, null);
  assert.deepEqual(r.args, []);
});

test("registry rejects duplicate command names", () => {
  defineCommand("test-dup", { summary: "first", run: () => 0 });
  assert.throws(() => defineCommand("test-dup", { summary: "second", run: () => 0 }), /already registered/);
  assert.equal(getCommand("test-dup").summary, "first");
});

test("registry returns commands sorted by name", () => {
  const names = commandNames();
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("unknown command resolves to null", () => {
  assert.equal(getCommand("definitely-not-a-command"), null);
});