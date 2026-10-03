// Redaction tests.
//
// These guard a security boundary: anything redacted here must never reach
// stdout, stderr, or the event log. A regression is a credential leak, so the
// cases are drawn from real credential formats rather than toy strings.

import test from "node:test";
import assert from "node:assert/strict";
import { redact, redactDeep } from "../src/core/redact.js";

test("redacts Google OAuth client secrets", () => {
  // Synthetic fixture. The upstream value that originally stood here was a real
  // leaked credential and was removed; see AUDIT/LICENSE_AUDIT.md.
  const out = redact('secret: "GOCSPX-EXAMPLEfixture0000notreal"');
  assert.ok(!out.includes("EXAMPLEfixture0000"), "secret must not survive");
  assert.ok(out.includes("GOCSPX-***"));
});

test("redacts provider API keys", () => {
  // Fixture only — not a live key. Any real key must be revoked and replaced
  // with a synthetic value like this one before being committed.
  const out = redact("token sk-EXAMPLE0fixture0value-do-not-use end");
  assert.ok(!out.includes("EXAMPLE0fixture0value"));
  assert.ok(out.includes("sk-***"));
});

test("redacts bearer headers", () => {
  const out = redact("Authorization: Bearer abcdef0123456789XYZ");
  assert.ok(!out.includes("abcdef0123456789XYZ"));
  assert.ok(out.includes("Bearer ***"));
});

test("redacts GitHub tokens", () => {
  const out = redact("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
  assert.ok(!out.includes("16C7e42F"));
});

test("redacts JWTs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const out = redact(`auth ${jwt} done`);
  assert.ok(!out.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r"));
});

test("redacts secrets in query strings", () => {
  const out = redact("https://api.example.com/v1?api_key=supersecretvalue123&x=1");
  assert.ok(!out.includes("supersecretvalue123"));
  assert.ok(out.includes("x=1"), "non-secret params must survive");
});

test("redacts by assignment", () => {
  const out = redact("clientSecret: 'my-long-secret-value'");
  assert.ok(!out.includes("my-long-secret-value"));
});

test("redactDeep masks sensitive keys regardless of value shape", () => {
  const out = redactDeep({
    apiKey: "anything-at-all",
    nested: { client_secret: "zzz", password: "hunter2" },
    list: [{ token: "abcdef123456" }],
    safe: "keep-me",
  });
  assert.equal(out.apiKey, "***");
  assert.equal(out.nested.client_secret, "***");
  assert.equal(out.nested.password, "***");
  assert.equal(out.list[0].token, "***");
  assert.equal(out.safe, "keep-me");
});

test("redactDeep survives circular references", () => {
  const a = { name: "loop" };
  a.self = a;
  const out = redactDeep(a);
  assert.equal(out.name, "loop");
  assert.equal(out.self, "[circular]");
});

test("redaction never throws on odd input", () => {
  for (const v of [null, undefined, 0, false, {}, [], Symbol.iterator.toString()]) {
    assert.doesNotThrow(() => redact(v));
    assert.doesNotThrow(() => redactDeep(v));
  }
});

test("redacts a realistic provider error payload", () => {
  const err = {
    status: 401,
    detail: { request: { headers: { Authorization: "Bearer sk-live-abcdefghijklmnop" } } },
  };
  const out = redactDeep(err);
  const asText = JSON.stringify(out);
  assert.ok(!asText.includes("sk-live-abcdefghijklmnop"));
});