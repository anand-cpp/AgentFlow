#!/usr/bin/env node
// Committed-credential scanner.
//
// Runs in CI so a leaked credential is caught during review rather than by
// GitHub push protection at push time.
//
// This is a shape-and-context check, not a full entropy analyser. It is
// deliberately narrow: a false positive here blocks a push, and a scanner that
// cries wolf gets disabled.
//
// Two modes, because they answer different questions:
//
//   (default)     scan the working tree -- "is the current checkout clean?"
//   --history     scan every blob reachable from any ref -- "did a secret ever
//                 get committed?"
//
// The history mode exists because of a real miss. This scanner reported "clean"
// on a repository whose git history contained a hardcoded Google API key in
// open-sse/providers/registry/windsurf.js. The rule that should have caught it
// was correct and present; the file had simply already been scrubbed at HEAD by
// the time the scanner first ran. A working-tree scan cannot see that class of
// problem, which is exactly the class that ends up as a public GitHub secret
// scanning alert.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Files whose whole job is to contain credential shapes: the redactor's
// patterns, the scanner's own rules, and tests that assert masking.
//
// Note that test/scan-secrets.test.js is deliberately NOT allowlisted: it builds
// its fixtures from fragments at runtime, so it contains no credential-shaped
// literal and the scanner can scan it honestly. An allowlist entry for a test
// file is a hole someone can later hide a real key in.
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

// --- high-entropy value detection -------------------------------------------
//
// Added after a real miss. The iFlow OAuth secret that leaked from the imported
// engine carried no distinguishing prefix, so no shape-based rule could name it.
// It was caught only because it happened to sit in an assignment named
// `clientSecret`, which the `inline-secret-assignment` rule covers by name. Had
// the upstream author called the field `auth` or `k`, it would have shipped.
//
// So: for assignments whose *name* implies a secret, measure the entropy of the
// value instead of its shape. This is deliberately confined to secret-named
// assignments. Running entropy across all string literals produces unusable
// false positives, because hashes, base64 test fixtures and minified content
// are all high-entropy by nature.

/** Shannon entropy in bits per character. */
export function shannonEntropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// A secret-named field holding a literal. Captures the value, not the key, so
// the entropy test applies to exactly the bytes that would be leaked.
// Group 1 is the opening quote and must be closed with \1; \2 is the value.
const SECRET_NAMED_ASSIGNMENT =
  /(?:^|[^\w$])(?:[A-Za-z0-9_$]*(?:secret|passwd|password|token|credential|private[_-]?key|auth)[A-Za-z0-9_$]*)\s*[:=]\s*(["'])([^"'\n]{16,})\1/g;

// Values that are references or shapes rather than stored secrets. Ordered
// cheapest-first; each pattern here has cost us a false positive in practice.
const NON_SECRET_VALUE = [
  /^\$\{/, // template interpolation
  /^\{\{/,
  /^process\.env/,
  /^\$/, // shell/env reference
  /^[a-z][a-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/, // dotted config path
  PATH_LIKE,
  /^https?:\/\//i,
  /^[a-z]+:\/\//i,
  /^\.{0,2}\//, // filesystem path
  /^[A-Za-z]:\\/,
  /<[^>]+>/, // placeholder
  /^[*x•]{3,}$/i,
];

/**
 * Strip a leading HTTP auth scheme so the entropy test judges the credential
 * rather than the fixed word in front of it. `Bearer abc123def456ghi789` is
 * dominated by the scheme's own letters, which masks the token's randomness and
 * produced a false positive on a synthetic fixture. Testing only the token
 * keeps real long bearer tokens detectable while ignoring the constant.
 */
export function stripAuthScheme(value) {
  return String(value).replace(/^(?:Bearer|Basic|Token|Digest|Negotiate)\s+/i, "");
}

/**
 * A value is "secret-shaped by entropy" when it is long enough, mixed enough,
 * and random enough. The mixed-charset requirement matters: real random secrets
 * use a broad character set, whereas long lowercase identifiers and long digit
 * runs are usually hashes of something else or just long words.
 */
export function looksHighEntropySecret(rawValue) {
  if (typeof rawValue !== "string") return false;
  const value = stripAuthScheme(rawValue).trim();
  if (value.length < 20) return false;
  if (NON_SECRET_VALUE.some((re) => re.test(value))) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  if (!/[0-9]/.test(value)) return false;
  // Reject a value dominated by one character, e.g. "aaaa...".
  if (new Set(value).size < 10) return false;
  return shannonEntropy(value) >= 3.2;
}

export const RULES = [
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
    // `AIza` + exactly 35 chars, which is the real Google API key shape. The
    // length is exact rather than a range on purpose: a range would also match
    // this scanner's own regex source and other incidental `AIza` text.
    //
    // Lower risk than an OAuth secret (Firebase keys ship in client bundles),
    // but hardcoding one still pins a fork to someone else's Firebase project.
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
  {
    // Entropy on a secret-named field. Shape-independent by construction, which
    // is the point: the value that actually leaked had no recognisable prefix,
    // so only its randomness gave it away. See shannonEntropy above for why
    // this is scoped to secret-named assignments instead of all string literals.
    name: "high-entropy-secret-value",
    re: SECRET_NAMED_ASSIGNMENT,
    isFixture: (m) => {
      const value = /(["'])([^"'\n]{16,})\1/.exec(m)?.[2] ?? "";
      return !looksHighEntropySecret(value);
    },
  },
];

function isTextPath(relPath, abs) {
  const ext = path.extname(relPath || abs).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  return true;
}

/**
 * Scan one blob of text. Returns findings with real 1-based line numbers.
 *
 * Exported so the rules can be tested directly. The tests build fixtures from
 * fragments at runtime rather than embedding credential literals, which is what
 * lets this file stay out of ALLOWLIST.
 */
export function scanText(text, { file = "<text>", allowlist = ALLOWLIST } = {}) {
  if (allowlist.has(path.normalize(file))) return [];

  const findings = [];
  const lines = String(text).split("\n");

  for (const rule of RULES) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`;
    const re = new RegExp(rule.re.source, flags);

    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        if (rule.isFixture(m[0])) continue;
        // One finding per rule per line is enough to act on.
        findings.push({ file, line: i + 1, rule: rule.name });
        break;
      }
    }
  }
  return findings;
}

function isTextFile(abs) {
  if (!isTextPath(null, abs)) return false;
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return false;
  }
  if (buf.length > MAX_BYTES) return false;
  if (buf.includes(0)) return false;
  return true;
}

function git(args, opts = {}) {
  // execFileSync returns a Buffer only when `encoding` is omitted; passing
  // "buffer" is not a valid encoding. Binary reads need it left off.
  const { binary = false, ...rest } = opts;
  const options = { maxBuffer: 1024 * 1024 * 1024, ...rest };
  if (!binary) options.encoding = "utf8";
  return execFileSync("git", args, options);
}

function trackedFiles(root) {
  try {
    return git(["ls-files", "-z"], { cwd: root }).split("\0").filter(Boolean);
  } catch {
    return null; // not a git repo, or git unavailable
  }
}

function walkFiles(root) {
  const out = [];
  const skip = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
  const stack = [root];
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

/** Scan the current checkout. */
export function scanWorkingTree(root = process.cwd()) {
  const relPaths = trackedFiles(root) ?? walkFiles(root).map((p) => path.relative(root, p));
  const findings = [];

  for (const relPath of relPaths) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
    if (!isTextFile(abs)) continue;
    findings.push(...scanText(fs.readFileSync(abs, "utf8"), { file: relPath }));
  }
  return { findings, scanned: relPaths.length };
}

/**
 * Scan every blob reachable from the given refs.
 *
 * Blobs are deduplicated by object id before reading, so a file that never
 * changed across 500 commits is scanned once, not 500 times. Findings are
 * reported against the path the blob had in at least one commit that contains
 * it, which is what a maintainer needs in order to act.
 *
 * Ref scoping matters here. This repository also carries local `master` and
 * `upstream/*` refs that mirror 9Router's full history, containing well over a
 * thousand credential-shaped strings in documentation that were never published
 * here. Scanning every ref buries the one finding that matters. The default is
 * therefore the published refs (refs/remotes/origin/*), because that is what
 * GitHub scans and what a leak actually costs.
 */
export function scanHistory(root = process.cwd(), refs = null) {
  let targets = refs;
  if (!targets || targets.length === 0) {
    // Scope to the *published* remote, not every remote. This repo also has
    // `upstream/*` tracking refs mirroring 9Router's full history; those were
    // never pushed here, and including them buries the real findings under
    // upstream's documentation examples.
    try {
      const published = git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"], { cwd: root })
        .split("\n")
        .filter(Boolean);
      targets = published.length ? published : ["HEAD"];
    } catch {
      targets = ["HEAD"];
    }
  }

  let objects;
  try {
    objects = git(["rev-list", "--objects", ...targets], { cwd: root });
  } catch (err) {
    return { findings: [], scanned: 0, refs: targets, error: `cannot read history for ${targets.join(", ")}` };
  }

  // "<sha> [<path>]" — path is absent for commits/trees.
  const pathsBySha = new Map();
  const shas = [];
  for (const line of objects.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    const sha = sp === -1 ? line : line.slice(0, sp);
    const p = sp === -1 ? "" : line.slice(sp + 1);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    if (!pathsBySha.has(sha)) {
      pathsBySha.set(sha, new Set());
      shas.push(sha);
    }
    if (p) pathsBySha.get(sha).add(p);
  }
  if (shas.length === 0) return { findings: [], scanned: 0, refs: targets };

  const typeBySha = new Map(
    git(["cat-file", "--batch-check"], {
      cwd: root,
      input: shas.join("\n") + "\n",
    })
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, type] = l.split(" ");
        return [sha, type];
      })
  );

  const blobShas = shas.filter((s) => typeBySha.get(s) === "blob");
  if (blobShas.length === 0) return { findings: [], scanned: 0, refs: targets };

  // Stream the blobs through one `git cat-file --batch` process.
  const raw = git(["cat-file", "--batch"], {
    cwd: root,
    input: Buffer.from(blobShas.join("\n") + "\n"),
    binary: true,
  }).toString("binary");

  const findings = [];
  let off = 0;
  let scanned = 0;
  for (const sha of blobShas) {
    const nl = raw.indexOf("\n", off);
    if (nl === -1) break;
    const header = raw.slice(off, nl);
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!m) break;
    const size = Number(m[2]);
    const start = nl + 1;
    const body = raw.slice(start, start + size);
    off = start + size + 1; // trailing newline

    if (size > MAX_BYTES || body.includes("\0")) continue;
    const text = Buffer.from(body, "binary").toString("utf8");
    scanned += 1;

    // Attribute the blob to the first path it was known by, so a finding points
    // somewhere a maintainer can look.
    const paths = [...pathsBySha.get(sha)];
    const relPath = paths[0] ?? `<blob ${sha.slice(0, 8)}>`;
    if (!isTextPath(relPath, relPath)) continue;
    findings.push(...scanText(text, { file: relPath }));
  }

  return { findings, scanned, refs: targets };
}

function report(findings, scanned, label) {
  if (findings.length === 0) {
    console.log(`scan-secrets: clean (${scanned} ${label} scanned)`);
    return 0;
  }
  console.error(`scan-secrets: ${findings.length} potential committed credential(s)\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.rule}`);
  console.error(
    "\nIf a hit is intentional (a detection pattern or synthetic fixture), add the\n" +
      "path to ALLOWLIST in scripts/scan-secrets.mjs with a comment explaining why.\n" +
      "Otherwise: revoke the credential first, then remove it from the commit.\n" +
      "Removing it from HEAD is not enough if --history finds it; the object is\n" +
      "still reachable and GitHub will keep alerting on it."
  );
  return 1;
}

function main(argv) {
  const history = argv.includes("--history");
  if (history) {
    const { findings, scanned, error } = scanHistory(process.cwd());
    if (error) {
      console.error(`scan-secrets: ${error}`);
      return 1;
    }
    return report(findings, scanned, "reachable blobs");
  }
  const { findings, scanned } = scanWorkingTree(process.cwd());
  return report(findings, scanned, "tracked files");
}

// Only run when invoked directly, so the tests can import the rules.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

export default { RULES, scanText, scanWorkingTree, scanHistory };