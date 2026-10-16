#!/usr/bin/env node
// Preview the next CHANGELOG entry.
//
// release.mjs writes the entry as part of cutting a release; this script is the
// read-only twin, so you can see what a release would record before you run it.
// It reads conventional-commit subjects since the last tag and groups them into
// the Keep a Changelog sections the file already uses.
//
// Usage:
//   npm run changelog                 # preview the next entry
//   npm run changelog -- --all        # ignore the tag and show everything

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Conventional commits -> the sections Keep a Changelog defines. Anything not
// recognised is treated as a change rather than dropped, because a release that
// silently omits a commit is worse than one that files it imperfectly.
const TYPE_TO_SECTION = {
  feat: "Added",
  fix: "Fixed",
  docs: "Changed",
  refactor: "Changed",
  perf: "Changed",
  test: "Changed",
  style: "Changed",
  build: "Changed",
  ci: "Changed",
  chore: "Changed",
};

const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function commitsSinceLastTag(all) {
  let range = "HEAD";
  if (!all) {
    try {
      range = `${git(["describe", "--tags", "--abbrev=0"])}..HEAD`;
    } catch {
      /* no tags yet: everything is new */
    }
  }
  const out = git(["log", range, "--no-merges", "--pretty=format:%s"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function group(subjects) {
  /** @type {Record<string, string[]>} */
  const grouped = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  for (const subject of subjects) {
    const m = /^([a-z]+)(?:\([^)]*\))?(!?):\s*(.+)$/.exec(subject);
    const type = m ? m[1] : "chore";
    const description = m ? m[3] : subject;
    const section = TYPE_TO_SECTION[type] || "Changed";
    grouped[section].push(`- ${description}`);
  }
  return grouped;
}

function main() {
  const all = process.argv.includes("--all");
  const subjects = commitsSinceLastTag(all);
  if (subjects.length === 0) {
    console.log("changelog: no commits since the last tag.");
    return 0;
  }

  const grouped = group(subjects);
  const seen = new Set();
  console.log(`# Pending changelog entry (${subjects.length} commit(s)${all ? ", --all" : " since the last tag"})`);
  console.log("");
  for (const section of SECTIONS) {
    const bullets = grouped[section].filter((b) => (seen.has(b) ? false : seen.add(b)));
    if (bullets.length === 0) continue;
    console.log(`### ${section}`);
    for (const b of bullets) console.log(b);
    console.log("");
  }
  console.log("To record this, cut a release: npm run release patch");
  return 0;
}
process.exit(main());
