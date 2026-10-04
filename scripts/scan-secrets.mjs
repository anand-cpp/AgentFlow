#!/usr/bin/env node
// Committed-credential scanner.
//
// Runs in CI so a leaked credential is caught during review rather than by
// GitHub push protection at push time.
//
// This is a shape-and-context check, not a full entropy analyser. It is
// deliberately narrow: a false positive here blocks a push, and a scanner that
// cries wolf gets disabled.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

// Files whose whole job is to contain credential shapes: the redactor's
// patterns, and tests that assert the redactor masks them.
const ALLOWLIST = new Set([
  path.normalize("src/core/redact.js"),
  path.normalize("test/redact.test.js"),
  "scripts/scan-secrets.mjs",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "AUDIT/LICENSE_AUDIT.md",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".sqlite", ".db",
]);

const MAX_BYTES = 1_500_000;

// A value shaped like a path of identifier segments is a *reference* to a
// stored value, not a stored value. `accessToken: "cursorAuth/accessToken"` in
// the Cursor registry is a SQLite column path — flagging it as a leak trains
// people to ignore the scanner. Requires clean identifier segments with no
// digits, so a random base64 blob still trips the rule.
const PATH_LIKE = /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)+$/;

const RULES = [
  {
    name: "google-oauth-client-secret",
    // Real GOCSPX values are base64url with mixed case. The placeholder used in
    // fixtures is rejected below.
    re: /GOCSPX-[A-Za-z0-9_-]{20,}/g,
    isFixture: (m) => /EXAMPLE|REDACTED|PLACEHOLDER|DO-NOT-USE/i.test(m),
  },
  {
    name: "google-oauth-client-id",
    re: /\b\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/g,
    isFixture: (m) => /example/i.test(m),
  },
  {
    name: "github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    isFixture: (m) => /EXAMPLE|REDACTED|PLACEHOLDER/i.test(m),
  },
  {
    name: "openai-style-key",
    re: /\bsk-[A-Za-z0-9_-]{24,}\b/g,
    isFixture: (m) => /EXAMPLE|REDACTED|PLACEHOLDER|DO-NOT-USE|FIXTURE/i.test(m),
  },
  {
    name: "firebase-web-api-key",
    // `AIza` + 35 chars. Lower risk than an OAuth secret (Firebase keys ship in
    // client bundles), but hardcoding one still pins a fork to someone else's
    // Firebase project — which is exactly what the Windsurf registry did.
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    isFixture: (m) => /EXAMPLE|REDACTED|PLACEHOLDER/i.test(m),
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    isFixture: () => false,
  },
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    isFixture: () => false,
  },
  {
    name: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    isFixture: () => false,
  },
  {
    // Generic assignment. Only fires on a name that is unambiguously secret, so
    // ordinary config (`apiKeyEnv`, `secretName`) does not trip it.
    name: "inline-secret-assignment",
    re: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
    isFixture: (m) =>
      /\$\{|\bprocess\.env\b|EXAMPLE|REDACTED|PLACEHOLDER|\*{3,}|<[^>]+>/i.test(m) ||
      PATH_LIKE.test(m.replace(/^\s*[^:=]+\s*[:=]\s*["']/, "").replace(/["'];?\s*$/, "")),
  },
];

function isTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  if (ext === ".md") return true;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (buf.length > MAX_BYTES) return false;
  // Reject anything with a NUL byte early.
  if (buf.includes(0)) return false;
  return true;
}

function trackedFiles() {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null; // not a git repo (or git unavailable): fall back to a walk
  }
  return out.split("\0").filter(Boolean);
}

function walkFiles() {
  const out = [];
  const skip = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
  const stack = [ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

const rel = (abs) => path.relative(ROOT, abs);
const candidates = trackedFiles() ?? walkFiles().map(rel);

const findings = [];
for (const relPath of candidates) {
  if (ALLOWLIST.has(path.normalize(relPath))) continue;
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  if (!isTextFile(abs)) continue;

  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split("\n");
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
    for (const line of lines) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (rule.isFixture(m[0])) continue;
        findings.push({ file: relPath, line: line.slice(0, m.index + 1).split("\n").length, rule: rule.name });
        break; // one finding per rule per line is enough
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`scan-secrets: clean (${candidates.length} tracked files scanned)`);
  process.exit(0);
}

console.error(`scan-secrets: ${findings.length} potential committed credential(s)\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.rule}`);
}
console.error(
  "\nIf a hit is intentional (a detection pattern or synthetic fixture), add the\n" +
    "path to ALLOWLIST in scripts/scan-secrets.mjs with a comment explaining why.\n" +
    "Otherwise: revoke the credential first, then remove it from the commit."
);
process.exit(1);