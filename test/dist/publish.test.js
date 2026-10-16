// `aflow publish` readiness command.
//
// These run the real CLI in a child process because the command's value is in
// its exit code -- the thing CI would actually gate on. The static checks are
// asserted to be green on this repository, which is the same claim the
// package-integrity tests make, but exercised through the command a maintainer
// would type.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "bin", "agentflow.js");

function runPublish(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, "publish", ...args],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout, stderr })
    );
  });
}

test("readiness passes on this repository", { timeout: 60000 }, async () => {
  const { code, stdout, stderr } = await runPublish([]);
  assert.equal(code, 0, `expected exit 0, got ${code}\n${stdout}\n${stderr}`);
});

test("--json reports checks with no error status", { timeout: 60000 }, async () => {
  const { code, stdout } = await runPublish(["--json"]);
  assert.equal(code, 0);
  const data = JSON.parse(stdout);
  assert.ok(Array.isArray(data.checks), "checks must be an array");
  const failed = data.checks.filter((c) => c.status === "error");
  assert.deepEqual(failed, [], `unexpected failing check(s): ${JSON.stringify(failed)}`);
  assert.match(data.version, /^\d+\.\d+\.\d+/, "version must be reported");
});

test("the command is registered so --help lists it", async () => {
  await import("../../src/commands/index.js");
  const { getCommand } = await import("../../src/cli/registry.js");
  const cmd = getCommand("publish");
  assert.ok(cmd, "publish command must be registered");
  assert.ok(cmd.usage.includes("never publishes"), "usage must state that it never publishes");
});
