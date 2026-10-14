// Provider setup wizard tests.
//
// Three layers, each failing for a different reason:
//
//   * keys.js -- the storage primitives. If parsing or the env merge is wrong,
//     every command downstream is wrong, and the failure is silent.
//   * the wizard command -- the readline loop and the write path, driven by a
//     piped Readable and a captured Writable, with an injected fetch. This is
//     where "does a pasted key actually land in keys.env, and does a bad key get
//     rejected" is proven.
//   * the non-interactive modes -- --check, --export, --reset.
//
// No test reaches the network: every fetch is injected. Secret-shaped fixtures
// are assembled from fragments at runtime so this file never contains a literal
// the repo's own scan-secrets would (correctly) flag.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { setupCommand, runSetup } from "../src/commands/setup.js";
import {
  parseDotenv,
  serializeKeys,
  mergeEnv,
  providerBaseUrl,
  formatExport,
  writeKeysFile,
  readKeysFile,
  KEYS_FILE_MODE,
} from "../src/core/keys.js";

// Assembled, not literal: a real-looking Groq key is `gsk_` + 52 chars, and the
// repo's scan-secrets looks for exactly that shape.
const FAKE_GROQ = "gsk" + "_" + "test" + "0000000000000000000000000000000000000000000000";
const FAKE_CEREBRAS = "csk" + "-" + "test" + "0000000000000000000000000000000000000000000000";

function scratch(prefix = "aflow-setup-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function captureOutput() {
  let captured = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  return { output, get text() { return captured; } };
}

function stubOut({ json = false } = {}) {
  const rendered = [];
  return {
    json,
    quiet: false,
    verbose: false,
    rendered,
    last() {
      return rendered[rendered.length - 1];
    },
    async init(result, renderText) {
      rendered.push({ result, text: typeof renderText === "function" ? renderText(result) : null });
    },
    info(message) {
      rendered.push({ info: message });
    },
    status(message) {
      rendered.push({ status: message });
    },
    error(message) {
      rendered.push({ error: message });
    },
    warn(message) {
      rendered.push({ warn: message });
    },
    detail(message) {
      rendered.push({ detail: message });
    },
  };
}

/** A response object shaped like the subset of `fetch`'s Response keys we use. */
function makeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

/**
 * An injected fetch that answers by substring match on the URL. The first route
 * whose key appears in the URL wins; unmatched URLs get a 404.
 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const href = String(url);
    calls.push({ url: href, opts });
    for (const [match, response] of Object.entries(routes)) {
      if (href.includes(match)) return makeResponse(response);
    }
    return makeResponse({ status: 404, body: { error: { message: "no mock route" } } });
  };
  fn.calls = calls;
  return fn;
}

/** Drive the wizard from piped input against a scratch keys file. */
async function runWizardCommand({ lines, keysFile, fetchImpl, env = {}, out = stubOut(), flags = {} }) {
  const input = Readable.from(lines);
  const io = captureOutput();
  const code = await setupCommand.run({
    flags: { "keys-file": keysFile, ...flags },
    config: {},
    out,
    deps: {
      input,
      output: io.output,
      interactive: false,
      fetchImpl,
      env,
      timeoutMs: 1000,
    },
  });
  return { code, io, out };
}

// ---------------------------------------------------------------------------
// keys.js: storage primitives
// ---------------------------------------------------------------------------

test("parseDotenv tolerates comments, quotes, export, and malformed lines", () => {
  const parsed = parseDotenv(
    [
      "# a comment",
      "",
      "GROQ_API_KEY=plain",
      'export CEREBRAS_API_KEY="quoted value"',
      "MISTRAL_API_KEY='single quoted'",
      "this line has no equals sign",
      "=novalue",
      "TOGETHER_API_KEY=",
    ].join("\n")
  );
  assert.equal(parsed.GROQ_API_KEY, "plain");
  assert.equal(parsed.CEREBRAS_API_KEY, "quoted value");
  assert.equal(parsed.MISTRAL_API_KEY, "single quoted");
  assert.equal(parsed.TOGETHER_API_KEY, "");
  assert.equal("this" in parsed, false, "a malformed line is skipped, not guessed at");
  assert.equal(Object.keys(parsed).length, 4);
});

test("mergeEnv puts the environment over the file and drops empty env values", () => {
  const merged = mergeEnv({ GROQ_API_KEY: "from-file", CEREBRAS_API_KEY: "file-cerebras" }, {
    GROQ_API_KEY: "from-env",
    MISTRAL_API_KEY: "",
  });
  assert.equal(merged.GROQ_API_KEY, "from-env", "process.env must win");
  assert.equal(merged.CEREBRAS_API_KEY, "file-cerebras", "file-only keys survive");
  assert.equal("MISTRAL_API_KEY" in merged, false, "an empty env var must not shadow the file");
});

test("providerBaseUrl substitutes {ENV_VAR} placeholders", () => {
  assert.equal(
    providerBaseUrl("https://x/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1", { CLOUDFLARE_ACCOUNT_ID: "acct" }),
    "https://x/accounts/acct/ai/v1"
  );
  assert.equal(providerBaseUrl("https://plain/v1", {}), "https://plain/v1");
});

test("formatExport quotes values differently per shell and escapes quotes", () => {
  const keys = { GROQ_API_KEY: "a'b", OTHER: "c\"d" };
  assert.deepEqual(formatExport(keys, { shell: "posix" }), [
    "export GROQ_API_KEY='a'\\''b'",
    "export OTHER='c\"d'",
  ]);
  assert.deepEqual(formatExport(keys, { shell: "powershell" }), [
    '$env:GROQ_API_KEY = "a\'b"',
    '$env:OTHER = "c`"d"',
  ]);
});

test("writeKeysFile then readKeysFile round-trips and never keeps a blank", () => {
  const dir = scratch();
  const file = path.join(dir, "keys.env");
  writeKeysFile(file, { GROQ_API_KEY: FAKE_GROQ, EMPTY: "" });
  const back = readKeysFile(file);
  assert.equal(back.GROQ_API_KEY, FAKE_GROQ);
  assert.equal("EMPTY" in back, false, "serializeKeys drops blank values");
  assert.equal(serializeKeys({ B: "2", A: "1" }).includes("A=1\nB=2"), true, "keys are sorted");
});

test("the keys file is written owner-only on Unix", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes do not exist on Windows");
    return;
  }
  const dir = scratch();
  const file = path.join(dir, "keys.env");
  writeKeysFile(file, { GROQ_API_KEY: FAKE_GROQ });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, KEYS_FILE_MODE, `expected 0600, got ${mode.toString(8)}`);
});

// ---------------------------------------------------------------------------
// wizard: interactive flow
// ---------------------------------------------------------------------------

test("the wizard writes a pasted key to keys.env after it tests the connection", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  const fetchImpl = mockFetch({
    // Ollama is not running; the wizard should note that and move on.
    "/api/tags": { status: 404 },
    "api.groq.com": { status: 200, body: { data: [{ id: "llama-3.3-70b-versatile" }] } },
  });

  const { code, io } = await runWizardCommand({ lines: [`${FAKE_GROQ}\n`], keysFile, fetchImpl, env: {} });

  assert.equal(code, 0);
  assert.match(io.text, /Provider Setup/);
  assert.match(io.text, /Connected/, "a good key must be reported connected");
  assert.match(io.text, /Groq/);

  const saved = readKeysFile(keysFile);
  assert.equal(saved.GROQ_API_KEY, FAKE_GROQ, "the key must land in keys.env");
});

test("a key the provider rejects is not written and the provider is skipped", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  const fetchImpl = mockFetch({
    "/api/tags": { status: 404 },
    "api.groq.com": { status: 401, body: { error: { message: "invalid api key" } } },
  });

  // Paste a bad key, then an empty line to decline the retry.
  const { code, io } = await runWizardCommand({ lines: [`${FAKE_GROQ}\n`, "\n"], keysFile, fetchImpl, env: {} });

  assert.equal(code, 0);
  assert.match(io.text, /Failed/);
  assert.match(io.text, /key rejected/);
  assert.equal(fs.existsSync(keysFile), false, "a rejected key must never be saved");
});

test("re-running keeps an already-configured key unless the user asks to reconfigure", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ });

  const env = { GROQ_API_KEY: FAKE_GROQ };
  const fetchImpl = mockFetch({ "/api/tags": { status: 404 } });

  // Decline reconfiguration (empty line), let everything else EOF-skip.
  const { code, io } = await runWizardCommand({ lines: ["\n"], keysFile, fetchImpl, env });

  assert.equal(code, 0);
  assert.match(io.text, /Already configured/);
  assert.match(io.text, /Kept existing key/);
  assert.equal(readKeysFile(keysFile).GROQ_API_KEY, FAKE_GROQ, "the existing key must survive untouched");
});

test("the wizard never overwrites a configured key with a blank environment present", async () => {
  // A stray empty GROQ_API_KEY in the environment must not erase the file key:
  // mergeEnv drops empties, so the provider still reads as configured.
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ });
  const fetchImpl = mockFetch({ "/api/tags": { status: 404 } });

  const { code, io } = await runWizardCommand({ lines: ["\n"], keysFile, fetchImpl, env: { GROQ_API_KEY: "" } });

  assert.equal(code, 0);
  assert.match(io.text, /Already configured/);
  assert.equal(readKeysFile(keysFile).GROQ_API_KEY, FAKE_GROQ);
});

// ---------------------------------------------------------------------------
// non-interactive: --check
// ---------------------------------------------------------------------------

test("--check reports each configured provider's reachability and exits 0 when all are up", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ, CEREBRAS_API_KEY: FAKE_CEREBRAS });
  const fetchImpl = mockFetch({
    "/api/tags": { status: 404 },
    "api.groq.com": { status: 200, body: { data: [{ id: "x" }] } },
    "api.cerebras.ai": { status: 200, body: { data: [{ id: "y" }] } },
  });

  const out = stubOut();
  const code = await runSetup({
    flags: { check: true, "keys-file": keysFile },
    config: {},
    out,
    deps: { fetchImpl, env: {}, timeoutMs: 1000 },
  });

  assert.equal(code, 0);
  const payload = out.last().result;
  assert.equal(payload.tested, 2);
  assert.equal(payload.failed, 0);
  assert.ok(payload.rows.some((r) => r.name === "Groq" && r.status === "reachable"));
  assert.ok(payload.rows.some((r) => r.name === "Cerebras" && r.status === "reachable"));
});

test("--check exits non-zero when a configured key is rejected", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ });
  const fetchImpl = mockFetch({
    "/api/tags": { status: 404 },
    "api.groq.com": { status: 401 },
  });

  const out = stubOut();
  const code = await runSetup({
    flags: { check: true, "keys-file": keysFile },
    config: {},
    out,
    deps: { fetchImpl, env: {}, timeoutMs: 1000 },
  });

  assert.equal(code, 1);
  const payload = out.last().result;
  assert.equal(payload.failed, 1);
});

// ---------------------------------------------------------------------------
// non-interactive: --export
// ---------------------------------------------------------------------------

test("--export prints shell export commands for the saved keys", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ });

  const out = stubOut();
  const code = await runSetup({
    flags: { export: true, "keys-file": keysFile, shell: "posix" },
    config: {},
    out,
    deps: { env: {} },
  });

  assert.equal(code, 0);
  const payload = out.last().result;
  assert.equal(payload.count, 1);
  assert.equal(payload.exports[0], `export GROQ_API_KEY='${FAKE_GROQ}'`);
  // The rendered text (what a human sees) is the same commands.
  assert.match(out.last().text, /export GROQ_API_KEY=/);
});

test("--export with no saved keys is a no-op that explains itself", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  const out = stubOut();
  const code = await runSetup({ flags: { export: true, "keys-file": keysFile }, config: {}, out, deps: { env: {} } });
  assert.equal(code, 0);
  assert.equal(out.last().result.count, 0);
  assert.match(out.last().text, /Nothing to export/);
});

// ---------------------------------------------------------------------------
// non-interactive: --reset
// ---------------------------------------------------------------------------

test("--reset --yes deletes the keys file", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ });
  const out = stubOut();
  const code = await runSetup({ flags: { reset: true, yes: true, "keys-file": keysFile }, config: {}, out, deps: { env: {} } });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(keysFile), false);
  assert.equal(out.last().result.reset, true);
});

test("--reset declined (non-interactive) keeps the keys and exits 1", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  writeKeysFile(keysFile, { GROQ_API_KEY: FAKE_GROQ });
  const input = Readable.from(["\n"]); // empty answer to the confirm prompt
  const io = captureOutput();
  const out = stubOut();
  const code = await runSetup({
    flags: { reset: true, "keys-file": keysFile },
    config: {},
    out,
    deps: { input, output: io.output, interactive: false, env: {} },
  });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(keysFile), true, "a declined reset must not delete anything");
});

test("--reset on a missing file reports nothing to do", async () => {
  const dir = scratch();
  const keysFile = path.join(dir, "keys.env");
  const out = stubOut();
  const code = await runSetup({ flags: { reset: true, yes: true, "keys-file": keysFile }, config: {}, out, deps: { env: {} } });
  assert.equal(code, 1);
  assert.equal(out.last().result.reason, "missing");
});

// ---------------------------------------------------------------------------
// argument handling
// ---------------------------------------------------------------------------

test("combining two modes is a usage error (exit 2)", async () => {
  const out = stubOut();
  const code = await runSetup({ flags: { check: true, export: true }, config: {}, out, deps: { env: {} } });
  assert.equal(code, 2);
  assert.match(out.last().result.error, /cannot be combined/);
});
