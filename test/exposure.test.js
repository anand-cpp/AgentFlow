// Tests for the known-exposure monitor and the entropy rule.
//
// Every credential-shaped string in this file is SYNTHETIC and generated at
// runtime from fragments. No real leaked value appears here, which is what lets
// scripts/scan-secrets.mjs scan this file honestly instead of allowlisting it.
// An allowlist entry for a test file is a hole someone can later hide a real key
// in, so this file deliberately avoids needing one.

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkExposures,
  probeContent,
} from "../scripts/check-exposure.mjs";
import {
  looksHighEntropySecret,
  scanText,
  shannonEntropy,
  stripAuthScheme,
} from "../scripts/scan-secrets.mjs";

// Synthetic shapes, assembled from fragments at runtime.
//
// The Firebase tail must be exactly 35 characters, because the real Google key
// shape is `AIza` plus exactly 35 -- the rule pins the length on purpose, so a
// range would also match the scanner's own regex source. Asserted below so a
// future edit cannot silently shorten the fixture and quietly stop testing it.
const FIREBASE_TAIL = "aB3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St0UvXyZ";
const SYNTHETIC_FIREBASE = `AIza${FIREBASE_TAIL}`;
const SYNTHETIC_SECRET = ["Qw7Er", "2Ty5Ui9Op3As7Df", "2Gh5Jk8Lz0"].join("");
const SYNTHETIC_GITHUB = ["ghp_", "aB3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St0Uv"].join("");

test("synthetic fixtures have the real shapes", () => {
  assert.equal(FIREBASE_TAIL.length, 35, "Google key tail must be exactly 35 chars");
  assert.equal(SYNTHETIC_FIREBASE.length, 39);
});

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

/** A fetch stub that serves `body` at any ref. */
function stubRetrievable(body) {
  return async () =>
    new Response(JSON.stringify({ encoding: "base64", content: b64(body) }), { status: 200 });
}

function stubStatus(status) {
  return async () => new Response("", { status });
}

const CONFIG = {
  exposures: [
    {
      id: "synthetic-firebase",
      repo: "example/repo",
      path: "providers/registry/windsurf.js",
      shape: "firebase-web-api-key",
      refs: ["aaaa1111"],
      ownerAction: "rotate it",
    },
  ],
};

// --- entropy rule -----------------------------------------------------------

test("entropy separates random material from word-like material", () => {
  const word = "supercalifragilistic";
  const randomish = SYNTHETIC_SECRET;
  assert.ok(
    shannonEntropy(randomish) > shannonEntropy(word),
    "uniform random must score higher than a long English word"
  );
  assert.ok(shannonEntropy("aaaaaaaa") < 1, "a repeated character has near-zero entropy");
});

test("entropy rule catches a secret that carries no distinguishing prefix", () => {
  // The value that actually leaked had no prefix, so no shape-based rule could
  // name it. This is the case that motivated the rule.
  const line = `auth: "${SYNTHETIC_SECRET}"`;
  const hits = scanText(line, { file: "t.js" });
  assert.ok(hits.length > 0, "unprefixed high-entropy value in a secret-named field must be flagged");
  assert.ok(hits.some((h) => h.rule === "high-entropy-secret-value"));
});

test("entropy rule does not fire on references, paths, or placeholders", () => {
  const safe = [
    "secret: process.env.MY_SECRET",
    "apiKey: process.env.API_KEY",
    "secret: vault.production.apiKey",
    "token: credentials/accessToken",
    'endpointSecret: "https://internal.example.com/v1"',
    'apiKey: "<your-key-here>"',
    'apiKey: "***"',
    'checksumSecret: "a3f5c9e17b2d8046af3c9e17b2d8046"',
    'pinSecret: "1234567890123456789012"',
    'token: "aaaaaaaaaaaaaaaaaaaaaaaa"',
    'secret: "supersecretvalue"',
    "apiKey: `${base}key`",
    'title: "MyVeryLongApplicationTitle"',
  ];
  for (const line of safe) {
    const hits = scanText(line, { file: "t.js" });
    assert.equal(hits.length, 0, `must not flag: ${line}`);
  }
});

test("auth scheme is stripped before the entropy judgement", () => {
  assert.equal(stripAuthScheme("Bearer abc123def456ghi789"), "abc123def456ghi789");
  // A short synthetic token behind a scheme is not a high-entropy secret.
  assert.equal(looksHighEntropySecret("Bearer abc123def456ghi789"), false);
  // A long random one still is, so stripping cannot be used to smuggle a secret.
  assert.equal(looksHighEntropySecret(`Bearer ${SYNTHETIC_SECRET}`), true);
});

test("a real bearer token behind a scheme is still detected", () => {
  const hits = scanText(`authorization: "Bearer ${SYNTHETIC_SECRET}"`, { file: "t.js" });
  assert.ok(hits.length > 0, "stripping the scheme must not create a blind spot");
});

test("known token shapes are detected by their own rules", () => {
  assert.ok(scanText(`key: "${SYNTHETIC_GITHUB}"`, { file: "t.js" }).length > 0);
  assert.ok(scanText(`key: "${SYNTHETIC_FIREBASE}"`, { file: "t.js" }).length > 0);
});

test("entropy rule never returns the value it judged", () => {
  const r = looksHighEntropySecret(SYNTHETIC_SECRET);
  assert.equal(typeof r, "boolean");
  assert.ok(!JSON.stringify(r).includes(SYNTHETIC_SECRET));
});

// --- exposure monitor -------------------------------------------------------

test("EXPOSED when a public ref still serves a credential shape", async () => {
  const probe = async () => ({
    state: "retrievable",
    body: `const firebaseApiKey = "${SYNTHETIC_FIREBASE}";\n`,
  });
  const [r] = await checkExposures(CONFIG, { probe });
  assert.equal(r.status, "EXPOSED");
  assert.equal(r.checked[0].state, "retrievable");
});

test("CLEAR only when every ref is positively confirmed gone", async () => {
  const probe = async () => ({ state: "gone" });
  const [r] = await checkExposures(CONFIG, { probe });
  assert.equal(r.status, "CLEAR");
});

test("a 404 reads as gone", async () => {
  const r = await probeContent({
    repo: "example/repo",
    ref: "abc",
    filePath: "x.js",
    fetchImpl: stubStatus(404),
  });
  assert.equal(r.state, "gone");
});

test("retrievable content matching a credential shape is reported with the rule name only", async () => {
  const probe = async () => ({ state: "retrievable", body: `k: "${SYNTHETIC_FIREBASE}"` });
  const [r] = await checkExposures(CONFIG, { probe });
  assert.equal(r.checked[0].shape, "firebase-web-api-key");
  // The matched value must not survive anywhere in the result.
  assert.ok(!JSON.stringify(r).includes(SYNTHETIC_FIREBASE));
});

test("a rate limit is UNKNOWN, never CLEAR", async () => {
  // The most dangerous possible bug in this monitor: a transient 403 reading as
  // "not exposed" would turn CI green while the credential stayed public.
  for (const status of [403, 429, 500, 503]) {
    const probe = async () => ({ state: "error", detail: `HTTP ${status}` });
    const [r] = await checkExposures(CONFIG, { probe });
    assert.equal(r.status, "UNKNOWN", `HTTP ${status} must not read as clean`);
  }
});

test("a network failure is UNKNOWN, never CLEAR", async () => {
  const probe = async () => ({ state: "error", detail: "ECONNRESET" });
  const [r] = await checkExposures(CONFIG, { probe });
  assert.equal(r.status, "UNKNOWN");
});

test("retrievable but no shape match is UNKNOWN, not CLEAR", async () => {
  // We can read the object but cannot confirm a credential. Claiming "clean"
  // would be a stronger statement than the evidence supports.
  const probe = async () => ({ state: "retrievable", body: "export const x = 1;\n" });
  const [r] = await checkExposures(CONFIG, { probe });
  assert.equal(r.status, "UNKNOWN");
});

test("one bad ref among several keeps the entry EXPOSED", async () => {
  const config = {
    exposures: [{ ...CONFIG.exposures[0], refs: ["aaaa1111", "bbbb2222"] }],
  };
  const probe = async ({ ref }) =>
    ref === "bbbb2222"
      ? { state: "gone" }
      : { state: "retrievable", body: `k: "${SYNTHETIC_FIREBASE}"` };
  const [r] = await checkExposures(config, { probe });
  assert.equal(r.status, "EXPOSED");
});

test("the shipped config carries no credential value", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("../config/exposure.json", import.meta.url), "utf8");
  // Structural assertions instead of a value blacklist: an exposure record is
  // only ever allowed to carry identifiers, paths and prose.
  const parsed = JSON.parse(raw);
  for (const e of parsed.exposures) {
    for (const key of Object.keys(e)) {
      assert.ok(
        ["id", "repo", "path", "shape", "refs", "committedOn", "ownerAction", "githubAlert", "notes"].includes(key),
        `unexpected field in exposure record: ${key}`
      );
    }
    for (const ref of e.refs) assert.match(ref, /^[0-9a-f]{7,40}$/, "refs must be commit ids");
  }
  // No long opaque strings that could be a pasted credential.
  for (const m of raw.matchAll(/[A-Za-z0-9_-]{24,}/g)) {
    assert.ok(
      /^[0-9a-f]{7,40}$/.test(m[0]) || /^(anand-cpp|open-sse|firebase|inline-secret|windsurf|iflow|decolua|AgentFlow|9router)/.test(m[0]),
      `suspicious opaque string in exposure config: ${m[0].slice(0, 12)}...`
    );
  }
});