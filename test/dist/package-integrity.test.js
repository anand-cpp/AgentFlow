// Distribution integrity.
//
// These tests guard the *published surface*: the fields npm reads, the file the
// `agentflow` and `aflow` bins point at, and the agreement between package.json
// and the version module. They run as part of `npm test`, so a break shows up
// as a red build rather than as a bad release -- which is the whole point of
// testing the distribution instead of only the behaviour.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/core/version.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("package name is the published name", () => {
  assert.equal(pkg.name, "agentflow-cli");
});

test("version is valid semver and matches the version module", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/);
  assert.equal(pkg.version, VERSION, "package.json and src/core/version.js must agree");
});

test("declares both the agentflow and aflow bins, pointing at the CLI entry", () => {
  assert.equal(pkg.bin.agentflow, "./bin/agentflow.js");
  assert.equal(pkg.bin.aflow, "./bin/agentflow.js");
});

test("the bin file exists and carries a node shebang", () => {
  const bin = path.join(ROOT, "bin", "agentflow.js");
  assert.ok(fs.existsSync(bin), "bin/agentflow.js must exist");
  const firstLine = fs.readFileSync(bin, "utf8").split("\n")[0];
  assert.equal(firstLine, "#!/usr/bin/env node");
});

test("files[] whitelists the runtime and legal files", () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "files whitelist must be present");
  for (const required of ["bin/", "src/", "open-sse/", "LICENSE", "README.md", "CHANGELOG.md"]) {
    assert.ok(pkg.files.includes(required), `files[] must include ${required}`);
  }
});

test("every path declared in files[] exists on disk", () => {
  for (const rel of pkg.files) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `files[] entry missing on disk: ${rel}`);
  }
});

test("the package is dependency-free at runtime", () => {
  const deps = pkg.dependencies || {};
  assert.equal(Object.keys(deps).length, 0, "runtime dependencies must stay empty");
});

test("engines pins a Node floor of at least 20", () => {
  assert.ok(pkg.engines && typeof pkg.engines.node === "string", "engines.node must be declared");
  const major = Number((pkg.engines.node.match(/\d+/) || [0])[0]);
  assert.ok(major >= 20, `Node floor must be >=20, got ${pkg.engines.node}`);
});

test("the package is ESM with an exports map and an existing main", () => {
  assert.equal(pkg.type, "module");
  assert.ok(pkg.exports && pkg.exports["."], "exports map must expose the root");
  assert.ok(pkg.main, "main must be set");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `main points at a missing file: ${pkg.main}`);
});

test(".npmignore excludes secrets and development trees", () => {
  const ignorePath = path.join(ROOT, ".npmignore");
  assert.ok(fs.existsSync(ignorePath), ".npmignore must exist");
  const ignore = fs.readFileSync(ignorePath, "utf8");
  for (const pattern of [".env", "test/", "node_modules/", "*.test.js"]) {
    assert.ok(ignore.includes(pattern), `.npmignore must exclude ${pattern}`);
  }
});
