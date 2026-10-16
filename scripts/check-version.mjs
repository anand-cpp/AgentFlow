#!/usr/bin/env node
// Version-sync guard.
//
// The version string has exactly one source of truth (package.json) and one
// accessor (src/core/version.js, which reads package.json at import time and
// re-exports it). This script exists to prove those two still agree, that the
// value is a valid semver, and that a bump landed in both places rather than
// one -- which is exactly how v0.2.0 shipped advertising 0.1.0.
//
// It runs as the first half of prepublishOnly and as a CI step, so an
// inconsistent bump fails the release instead of reaching the registry.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/core/version.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Accepts 1.2.3, 1.2.3-beta.1, and 1.2.3+build. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  /** @type {string[]} */
  const problems = [];

  if (typeof pkg.version !== "string" || !SEMVER.test(pkg.version)) {
    problems.push(`package.json version "${pkg.version}" is not valid semver`);
  }
  if (!SEMVER.test(VERSION)) {
    problems.push(`src/core/version.js VERSION "${VERSION}" is not valid semver`);
  }
  if (pkg.version !== VERSION) {
    problems.push(
      `version mismatch: package.json=${pkg.version} but src/core/version.js=${VERSION}`
    );
  }

  if (problems.length) {
    console.error("check-version: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  console.log(`check-version: ok (${VERSION})`);

  // The changelog is documentation, not a gate: a missing entry is a warning so
  // that a mid-cycle publish is not blocked by prose, only made visible.
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : "";
  if (!changelog.includes(`[${pkg.version}]`) && !changelog.includes("[Unreleased]")) {
    console.warn(
      `check-version: warning — CHANGELOG.md has no [${pkg.version}] or [Unreleased] entry`
    );
  }
  return 0;
}

process.exit(main());
