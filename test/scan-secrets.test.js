// Tests for the committed-credential scanner.
//
// The important property here is that the scanner is proven to catch the things
// it claims to catch. A scanner whose only validation is a fixture the author
// wrote to match their own regex proves nothing -- which is exactly how a real
// Google API key sat in this repository's history while the scanner reported
// "clean".
//
// Every fixture below is assembled from fragments at runtime. That is not
// stylistic: it means this file contains no credential-shaped literal, so it
// does not need an ALLOWLIST exemption, and so the scanner can scan its own
// test suite honestly. An allowlisted test file is a hole a future contributor
// can drop a real key into.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { scanText, scanWorkingTree, scanHistory } from "../scripts/scan-secrets.mjs";

// Deterministic pseudo-random tail so a fixture has realistic shape and length
// without being a real credential.
function fakeTail(length, seed = 7, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
  let out = "";
  let s = seed;
  for (let i = 0; i < length; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += alphabet[s % alphabet.length];
  }
  return out;
}

// Each fixture reproduces the *shape and length* of a real credential class.
// Where a provider constrains its alphabet (Google client ids are lowercase
// alphanumerics) the fixture must respect it, otherwise the test would be
// asserting against a shape the provider never issues.
const FIXTURES = {
  // The class that actually leaked: Google API keys are AIza + exactly 35.
  "firebase-web-api-key": `AIza${fakeTail(35)}`,
  "google-oauth-client-secret": `GOCSPX-${fakeTail(28)}`,
  "google-oauth-client-id": `1234567890-${fakeTail(21, 11, "abcdefghijklmnopqrstuvwxyz0123456789")}.apps.googleusercontent.com`,
  "github-token": `ghp_${fakeTail(36, 13)}`,
  "openai-style-key": `sk-${fakeTail(32, 17)}`,
  "aws-access-key-id": `AKIA${fakeTail(16, 19, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`,
  "slack-token": `xoxb-${fakeTail(30, 23)}`,
  // Assembled from fragments so this source file contains no PEM header literal;
  // see the guard test below.
  "private-key-block": `-----BEGIN ${"RSA"} PRIVATE KEY-----`,
};

test("every fixture is caught by the rule that claims to catch it", () => {
  for (const [rule, value] of Object.entries(FIXTURES)) {
    const findings = scanText(`const x = "${value}";`, { file: "sample.js" });
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes(rule), `expected ${rule} to be caught, got [${rules.join(", ")}]`);
  }
});

test("Google API key length is exact, matching the real 39-char shape", () => {
  const key = FIXTURES["firebase-web-api-key"];
  assert.equal(key.length, 39);
  assert.equal(key.startsWith("AIza"), true);
  // A short AIza-prefixed string must not fire: exact length is what keeps the
  // scanner's own regex source and unrelated text out of the results.
  assert.deepEqual(scanText('const s = "AIzaShortStuff";', { file: "a.js" }), []);
});

test("findings carry the real line number, not always 1", () => {
  const text = ["// line 1", "// line 2", "// line 3", `const k = "${FIXTURES["github-token"]}";`, "// line 5"].join("\n");
  const findings = scanText(text, { file: "a.js" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
  assert.equal(findings[0].file, "a.js");
});

test("fixtures and placeholders are not reported", () => {
  const cases = [
    'const k = "AIzaEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPL";',
    'const k = "AIzaREDACTEDREDACTEDREDACTEDREDACTED";',
    'const k = "ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXA";',
    'const s = "sk-EXAMPLE-EXAMPLE-EXAMPLE-EXAMPLE-1234";',
  ];
  assert.deepEqual(scanText(cases.join("\n"), { file: "a.js" }), []);
});

test("env-var indirection and column paths are not reported", () => {
  const benign = [
    'const key = process.env.GOOGLE_API_KEY;',
    'const key = "${process.env.API_KEY}";',
    'const accessToken: "cursorAuth/accessToken"',
    'const apiKeyEnv: "GOOGLE_API_KEY";',
    'const clientSecret: "<redacted>";',
    'password: "***REDACTED***"',
  ].join("\n");
  assert.deepEqual(scanText(benign, { file: "a.js" }), []);
});

test("allowlisted paths are skipped entirely", () => {
  const leaky = `const k = "${FIXTURES["github-token"]}";`;
  assert.equal(scanText(leaky, { file: "src/core/redact.js" }).length, 0);
  assert.equal(scanText(leaky, { file: "test/redact.test.js" }).length, 0);
  assert.ok(scanText(leaky, { file: "src/core/other.js" }).length > 0);
});

test("this test file contains no credential-shaped literal", () => {
  // If a future edit hardcodes a real-looking key here, the scanner would flag
  // it (this file is not allowlisted). Guard the guard.
  const self = fs.readFileSync(new URL(import.meta.url), "utf8");
  assert.deepEqual(scanText(self, { file: "test/scan-secrets.test.js" }), []);
});

// --- end-to-end, against a throwaway git repo -------------------------------

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-scan-"));
  // `input` alone, never `input` together with `stdio`: Node 20 rejects that
  // combination with ERR_INVALID_ARG_VALUE, and it was only relaxed later.
  // `input` already implies a piped stdin, so `stdio` bought nothing.
  const run = (args, input) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", input });

  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  return { dir, run };
}

test("--history finds a secret that was scrubbed from HEAD", () => {
  const { dir, run } = initRepo();
  const leaked = FIXTURES["firebase-web-api-key"];

  fs.writeFileSync(path.join(dir, "config.js"), `const key = "${leaked}";\n`);
  run(["add", "-A"]);
  run(["commit", "-qm", "import engine"]);

  // Scrub it, exactly as the real remediation did.
  fs.writeFileSync(path.join(dir, "config.js"), 'const key = process.env.GOOGLE_API_KEY;\n');
  run(["add", "-A"]);
  run(["commit", "-qm", "scrub credentials"]);

  // Working tree is clean...
  assert.deepEqual(scanWorkingTree(dir).findings, []);
  // ...but the object is still reachable, which is what GitHub alerts on.
  const hist = scanHistory(dir);
  assert.ok(hist.findings.length > 0, "history scan must still find the scrubbed key");
  assert.ok(hist.findings.some((f) => f.rule === "firebase-web-api-key"));
});

test("--history is clean when no secret was ever committed", () => {
  const { dir, run } = initRepo();
  fs.writeFileSync(path.join(dir, "ok.js"), 'const key = process.env.API_KEY;\n');
  run(["add", "-A"]);
  run(["commit", "-qm", "clean"]);
  assert.deepEqual(scanHistory(dir).findings, []);
});

test("--history dedupes blobs that never changed", () => {
  const { dir, run } = initRepo();
  // same.js is byte-identical across all five commits; the changing file keeps
  // each commit non-empty. Only the two distinct blobs should be scanned.
  fs.writeFileSync(path.join(dir, "same.js"), "const value = 1;\n");
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(dir, "changing.txt"), `revision ${i}\n`);
    run(["add", "-A"]);
    run(["commit", "-qm", `commit ${i}`]);
  }
  const hist = scanHistory(dir);
  // 6 unique blobs, not 10 file instances: same.js appears in all five commits
  // but is stored once, and changing.txt genuinely differs each time.
  assert.equal(hist.scanned, 6, `expected 6 unique blobs, got ${hist.scanned}`);
});

test("scanner is clean on its own repository", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const res = scanWorkingTree(root);
  assert.deepEqual(res.findings, [], `unexpected findings: ${JSON.stringify(res.findings)}`);
  assert.ok(res.scanned > 100, `expected a substantial tracked file count, got ${res.scanned}`);
});