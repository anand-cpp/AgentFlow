#!/usr/bin/env node
// Cut a release locally -- without pushing anything.
//
// The release flow is three deliberate steps, and this script performs the
// first two while refusing the third:
//
//   1. run the full gate on the current, un-bumped tree;
//   2. bump the version, record it in CHANGELOG.md, commit, and tag;
//   3. ... then stop and print the one command that publishes (git push --tags),
//      so a human reviews the commit and the tag before the tag triggers the
//      npm and binary workflows.
//
// Doing the push here would remove the review step, which is the whole reason a
// release is manual. It would also make a mistake unrecoverable once a tag is
// on the remote.
//
// Usage:
//   node scripts/release.mjs patch
//   node scripts/release.mjs minor
//   node scripts/release.mjs major
//   node scripts/release.mjs 1.2.3

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** git, without a shell, so arguments are never re-parsed. */
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** npm, through the shell, so npm.cmd resolves on Windows. */
function npm(args) {
  execSync(`npm ${args}`, { cwd: ROOT, stdio: "inherit" });
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) fail(`current version "${current}" is not plain semver; bump it explicitly`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`unknown release type "${kind}" (use patch|minor|major or an explicit x.y.z)`);
}

/** Commit subjects since the last tag, newest last as git lists them. */
function subjectsSinceLastTag() {
  let range = "HEAD";
  try {
    const lastTag = git(["describe", "--tags", "--abbrev=0"]);
    range = `${lastTag}..HEAD`;
  } catch {
    /* no tags yet: everything is new */
  }
  const out = git(["log", range, "--no-merges", "--pretty=format:%s"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Insert a release section just below [Unreleased] and above the previous
 * release, which is the order Keep a Changelog expects (newest first, except
 * Unreleased which always sits on top).
 */
function updateChangelog(version, date, subjects) {
  const text = fs.readFileSync(CHANGELOG, "utf8");
  const headings = [...text.matchAll(/^## \[/gm)];
  const insertAt = headings.length >= 2 ? headings[1].index : text.length;
  const seen = new Set();
  const bullets = subjects
    .filter((s) => (seen.has(s) ? false : seen.add(s)))
    .map((s) => `- ${s}`)
    .join("\n");
  const section = `## [${version}] - ${date}\n\n### Changed\n\n${bullets || "- (no commits since last tag)"}\n\n`;
  fs.writeFileSync(CHANGELOG, text.slice(0, insertAt) + section + text.slice(insertAt));
}

function main() {
  const kind = process.argv[2];
  if (!kind) fail("usage: node scripts/release.mjs <patch|minor|major|x.y.z>");

  // 1. Clean tree. A release that starts on top of uncommitted work cannot be
  //    reproduced from the tag, so refuse before doing anything.
  if (git(["status", "--porcelain"])) fail("working tree is dirty; commit or stash first");

  // 2. The gate, on the current tree -- before the version is touched.
  console.log("release: running the full gate (prepublishOnly)");
  npm("run prepublishOnly");

  const current = readVersion();
  const next = nextVersion(current, kind);
  console.log(`release: ${current} -> ${next}`);

  // 3. Bump package.json and package-lock.json. --no-git-tag-version keeps npm
  //    out of the commit/tag flow; we do those ourselves so the CHANGELOG edit
  //    lands in the same commit.
  npm(`version ${next} --no-git-tag-version`);

  // 4. The version module reads package.json, so this should never fail -- it is
  //    the assertion that they still agree after a bump.
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "check-version.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });

  // 5. CHANGELOG entry from the commits since the last tag.
  const date = new Date().toISOString().slice(0, 10);
  updateChangelog(next, date, subjectsSinceLastTag());

  // 6. Commit and tag. No push.
  git(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
  git(["commit", "-m", `chore(release): v${next}`]);
  git(["tag", `v${next}`]);

  console.log("");
  console.log(`release: v${next} committed and tagged locally.`);
  console.log("release: nothing was pushed. To publish, review the commit and run:");
  console.log("release:   git push origin HEAD --tags");
  return 0;
}

try {
  process.exitCode = main() ?? 0;
} catch (err) {
  fail(err?.message || String(err));
}
