import test from "node:test";
import assert from "node:assert/strict";

import { redact, redactDeep, redactVerified, containsSecret } from "../src/core/redact.js";

// Edge cases the main redact.test.js does not reach: mixed nested shapes,
// arrays of secrets, the primitive values a redactor must not distort, and the
// one case redactVerified exists for -- a secret redactDeep itself misses.

const LONG_SK = "sk-live-abcdefghij123456"; // sk- + 21 chars: matches the sk-key pattern.

test("redactDeep redacts sensitive keys at any depth", () => {
  const input = {
    apiKey: LONG_SK,
    nested: { inner: { accessToken: "ghp_abcdefghijklmnop", label: "keep" } },
    list: [{ password: "pw" }, "plain"],
  };

  const out = redactDeep(input);

  assert.equal(out.apiKey, "***");
  assert.equal(out.nested.inner.accessToken, "***");
  assert.equal(out.nested.inner.label, "keep");
  assert.equal(out.list[0].password, "***");
  assert.equal(out.list[1], "plain");
});

test("redactDeep keeps unknown keys and ordinary values untouched", () => {
  const out = redactDeep({ alpha: "a", beta: "b" });
  assert.deepEqual(out, { alpha: "a", beta: "b" });
});

test("redact passes string primitives through unchanged and nullish through as-is", () => {
  assert.equal(redact("hello"), "hello");
  assert.equal(redact(""), "");
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(LONG_SK), "sk-***");
});

test("redactDeep preserves non-object primitives", () => {
  assert.equal(redactDeep(42), 42);
  assert.equal(redactDeep(true), true);
  assert.equal(redactDeep(null), null);
  assert.equal(redactDeep(undefined), undefined);
});

test("redactVerified accepts a clean value", () => {
  assert.deepEqual(redactVerified({ id: 1, note: "n" }), { id: 1, note: "n" });
});

test("redactVerified throws on a secret that redactDeep leaves behind", () => {
  // A secret-shaped *key name* is not in SENSITIVE_KEYS, so redactDeep keeps it.
  // The value is redacted in place, but re-running the redactor over the
  // serialised result changes it -- which is exactly the residue the
  // verification gate exists to refuse.
  const secret = { [LONG_SK]: "value" };
  assert.deepEqual(redactDeep(secret), secret);
  assert.throws(() => redactVerified(secret), /refusing to persist/i);
});

test("containsSecret spots known secret shapes and misses ordinary text", () => {
  assert.equal(containsSecret(LONG_SK), true);
  assert.equal(containsSecret("no secrets here"), false);
  assert.equal(containsSecret(null), false);
  assert.equal(containsSecret(undefined), false);
});

test("redactDeep does not mutate its input", () => {
  const input = { token: "t" };
  const out = redactDeep(input);
  assert.equal(out.token, "***");
  assert.equal(input.token, "t");
});

test("redactDeep walks nested arrays of primitives and objects", () => {
  const out = redactDeep([1, "two", { note: "Bearer abc" }, [null]]);
  assert.equal(out[0], 1);
  assert.equal(out[1], "two");
  assert.equal(out[2].note, "Bearer abc");
  assert.equal(out[3][0], null);
});

test("redactDeep reports a repeat reference as [circular]", () => {
  const shared = { id: 1 };
  const out = redactDeep({ a: shared, b: shared });
  assert.equal(out.a.id, 1);
  assert.equal(out.b, "[circular]");
});
