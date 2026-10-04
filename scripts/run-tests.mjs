#!/usr/bin/env node
// Portable test entry point.
//
// Why this exists instead of a glob in package.json:
//
//   "test": "node --test \"test/**/*.test.js\""
//
// Node 22 added glob expansion to the test runner. Node 20 does not have it --
// it treats the quoted pattern as a literal path and fails with
//
//   Could not find '/.../test/**/*.test.js'
//
// which is how CI shipped a test script that could not run on the oldest Node
// version this project claims to support. A shell glob was not an option either:
// npm runs scripts through `sh` on Linux and `cmd` on Windows, and only the
// former expands `test/*.test.js`.
//
// So enumerate the files here, where one code path works on every supported
// version and on every platform, and hand the runner an explicit list. This
// also keeps the runner from auto-discovering tests inside `.next/standalone`,
// which is a 590-package 9Router build tree that happens to sit in this working
// directory and is not covered by .gitignore's test rules.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(ROOT, "test");

function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(full));
    else if (e.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

const files = collect(TEST_DIR);
if (files.length === 0) {
  console.error("run-tests: no *.test.js files found under test/");
  process.exit(1);
}

// Relative paths keep the reporter output readable and comparable to local runs.
const rel = files.map((f) => path.relative(ROOT, f));
console.log(`run-tests: ${rel.length} test file(s) on node ${process.version}`);

const res = spawnSync(process.execPath, ["--test", ...rel], {
  cwd: ROOT,
  stdio: "inherit",
});

if (res.error) {
  console.error(`run-tests: failed to launch node --test: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);