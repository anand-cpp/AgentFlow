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