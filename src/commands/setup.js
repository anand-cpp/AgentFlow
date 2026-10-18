// `aflow setup` -- the provider wizard.
//
// This is the command that turns "point AgentFlow at a gateway and hope" into
// "answer a few prompts and it works". It walks the user through each hosted
// provider's free tier, stores the key, and proves the key works before moving on.
//
// Three commitments shape the implementation:
//
//   1. Honesty. Every provider step names the signup URL, what the free tier is,
//      and whether a credit card is required, and the summary says plainly that
//      free tiers change. A wizard that overstates what a plan includes is worse
//      than no wizard.
//
//   2. Keys never leak into the repo. Keys are written only to `keys.env` under
//      the platform state directory (0600 on Unix), never to a project config
//      file. `--export` is the single place a value is printed, and only because
//      the user asked for the commands that put it in their shell.
//
//   3. Re-run safety. Running setup again detects already-configured providers
//      and asks before overwriting. A key is never clobbered silently.
//
// The command reads `ctx.deps` like `chat` and `tribunal` do: production passes
// nothing, tests inject the input stream, output stream, fetch, and keys file so
// the wizard can be driven end to end without a terminal or a network.

import process from "node:process";
import fs from "node:fs";
import readline from "node:readline";

import { defineCommand } from "../cli/registry.js";
import { PROVIDERS, GATEWAY_DEFAULTS } from "../core/gateway-server.js";
import {
  defaultKeysFile,
  readKeysFile,
  writeKeysFile,
  removeKeysFile,
  mergeEnv,
  providerReady,
  testProvider,
  formatExport,
  PROVIDER_TEST_TIMEOUT_MS,
} from "../core/keys.js";
import { bold, dim, red, green, yellow, cyan, symbol, table } from "../cli/ui.js";

const USAGE_ERROR = 2;

/**
 * Cloud providers in the order the wizard presents them.
 *
 * Grouped by familiarity rather than alphabetically: the well-known names come
 * first, so a user who stops after two or three has the ones they have heard of.
 */
const CLOUD_ORDER = [
  "groq",
  "cerebras",
  "gemini",
  "mistral",
  "openrouter",
  "cloudflare",
  "hf",
  "together",
  "fireworks",
  "deepinfra",
  "sambanova",
];

function usage(message) {
  const err = /** @type {Error & { usage: boolean }} */ (new Error(message));
  err.usage = true;
  return err;
}

function resolveIO(deps) {
  const input = deps.input || process.stdin;
  const output = deps.output || process.stdout;
  const interactive = deps.interactive ?? Boolean(input?.isTTY && output?.isTTY);
  return { input, output, interactive };
}

function resolveKeysFile(flags, deps) {
  if (flags["keys-file"]) return String(flags["keys-file"]);
  if (deps.keysFile) return String(deps.keysFile);
  return defaultKeysFile();
}

/**
 * A line prompter built on a persistent queue rather than `rl.question`, for the
 * same reason the chat loop is: a piped producer that writes several lines faster
 * than the wizard can ask drops the extras with `question`. `ask` returns null at
 * EOF, which every caller treats as "skip the rest".
 */
function createPrompter(io) {
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: io.interactive });
  let closed = false;
  let waiter = null;
  const queue = [];

  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  });
  rl.on("SIGINT", () => {
    io.output.write("\n");
    rl.close();
  });

  const next = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };

  const ask = async (question) => {
    if (io.interactive) {
      rl.setPrompt(question);
      rl.prompt();
    } else {
      io.output.write(question);
    }
    return await next();
  };

  return { ask, close: () => rl.close() };
}

const divider = (title) => `${dim("───")} ${bold(title)} ${dim("───")}`;

/** Probe the local Ollama instance. Never throws. */
async function checkOllama(ollamaUrl, fetchImpl, timeoutMs) {
  const base = String(ollamaUrl).replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/api/tags`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = /** @type {{ models?: Array<{ name?: string }> }} */ (await res.json());
    const models = (body?.models || []).map((m) => m?.name).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, reason: err?.name === "TimeoutError" ? "timed out" : err?.message || String(err) };
  }
}

/**
 * Test one provider's key and, if asked, loop on failure.
 *
 * Returns the accepted credential map for the provider, or null when the user
 * skips. The tester is the cheap `GET /models` probe from keys.js; a rejected
 * key is reported as such rather than as a network error.
 */
async function configureProvider({ prompter, io, spec, merged, fetchImpl, timeoutMs }) {
  // Collect the credential(s). A multiKey provider needs every env key; the
  // others need just the first.
  const needed = spec.multiKey ? spec.envKeys : [spec.envKeys[0]];

  for (let attempt = 0; attempt < 3; attempt++) {
    const collected = {};
    let skipped = false;
    for (const envKey of needed) {
      const answer = await prompter.ask(`  ${dim("Paste")} ${cyan(envKey)} ${dim("(Enter to skip):")} `);
      if (answer === null) return null; // EOF
      const value = answer.trim();
      if (!value) {
        // A multiKey provider needs all of them; skipping any skips the provider.
        skipped = true;
        break;
      }
      collected[envKey] = value;
    }
    if (skipped) {
      io.output.write(`  ${yellow("Skipped.")}\n`);
      return null;
    }

    const testEnv = { ...merged, ...collected };
    io.output.write(`  ${dim("Testing…")}`);
    const result = await testProvider(spec, { env: testEnv, fetchImpl, timeoutMs });
    if (result.ok) {
      const extra = result.modelCount != null ? ` ${dim(`(${result.modelCount} model(s))`)}` : "";
      io.output.write(`\r  ${green(`${symbol("ok")} Connected`)}${extra}\n`);
      return collected;
    }

    io.output.write(`\r  ${red(`${symbol("fail")} Failed`)} ${dim(`— ${result.reason}`)}\n`);
    const again = await prompter.ask(`  ${dim("Re-enter to retry, or Enter to skip:")} `);
    if (again === null || !again.trim()) {
      io.output.write(`  ${yellow("Skipped.")}\n`);
      return null;
    }
  }
  io.output.write(`  ${yellow("Gave up after 3 attempts; skipped.")}\n`);
  return null;
}

async function runWizard({ flags, config, out, deps, io, keysFile, fetchImpl, timeoutMs }) {
  const ollamaUrl = flags["ollama-url"] ? String(flags["ollama-url"]) : config?.ollamaUrl || GATEWAY_DEFAULTS.ollamaUrl;
  const processEnv = deps.env || process.env;

  const fileKeys = readKeysFile(keysFile);

  const total = 1 + CLOUD_ORDER.length;
  const configured = [];
  const skipped = [];
  const pending = {};

  io.output.write(`\n${bold("AgentFlow Provider Setup")}\n`);
  io.output.write(`${"=".repeat(39)}\n\n`);
  io.output.write("This wizard helps you configure free AI provider API keys.\n");
  io.output.write("All keys are stored locally in your AgentFlow state directory.\n");
  io.output.write("No keys are sent anywhere except the provider's own API.\n\n");
  io.output.write("You can skip any provider by pressing Enter.\n\n");
  io.output.write(`${dim("Free tiers change over time and are subject to each provider's terms.")}\n\n`);

  const prompter = createPrompter(io);
  try {
    // --- local -------------------------------------------------------------
    io.output.write(`${divider("Local Inference")}\n\n`);
    io.output.write(`[1/${total}] ${bold("Ollama")} ${dim("(local, unlimited, no key needed)")}\n`);
    const local = await checkOllama(ollamaUrl, fetchImpl, timeoutMs);
    if (local.ok) {
      io.output.write(`  Checking... ${green(`${symbol("ok")} Found at ${ollamaUrl}`)}\n`);
      if (local.models.length) {
        io.output.write(`  Models available: ${local.models.slice(0, 6).join(", ")}\n`);
      } else {
        io.output.write(`  ${dim("No models pulled yet — run `ollama pull qwen2.5-coder`.")}\n`);
      }
      configured.push("Ollama (local)");
    } else {
      io.output.write(`  Checking... ${yellow("not found")} ${dim(`— ${local.reason}`)}\n`);
      io.output.write(`  ${dim("Install Ollama for free, unlimited local inference: https://ollama.com")}\n`);
      skipped.push("Ollama (local)");
    }
    io.output.write("\n");

    // --- cloud -------------------------------------------------------------
    io.output.write(`${divider("Cloud Free Tiers")}\n\n`);
    let step = 2;
    for (const name of CLOUD_ORDER) {
      const spec = PROVIDERS[name];
      if (!spec) continue;
      const label = spec.label || name;
      const rate = spec.ratePerMin ? `${spec.ratePerMin} req/min, ` : "";
      const card = spec.creditCard ? "credit card required" : "no credit card";
      io.output.write(`[${step}/${total}] ${bold(label)} ${dim(`(${rate}${card})`)}\n`);
      io.output.write(`  Get your free key at: ${cyan(spec.signupUrl)}\n`);
      io.output.write(`  ${dim(`Free tier: ${spec.freeTier}`)}\n`);

      const view = mergeEnv(fileKeys, processEnv);
      const already = providerReady(spec, { ...view, ...pending });
      if (already) {
        io.output.write(`  ${green(`${symbol("ok")} Already configured.`)}\n`);
        const answer = await prompter.ask(`  ${dim("Reconfigure? [y/N]:")} `);
        if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
          io.output.write(`  ${dim("Kept existing key.")}\n\n`);
          configured.push(label);
          step++;
          continue;
        }
      }

      const accepted = await configureProvider({ prompter, io, spec, merged: { ...view, ...pending }, fetchImpl, timeoutMs });
      if (accepted) {
        Object.assign(pending, accepted);
        configured.push(label);
      } else {
        skipped.push(label);
      }
      io.output.write("\n");
      step++;
    }
  } finally {
    prompter.close();
  }

  // Persist whatever was newly entered. Never overwrite silently: `pending` only
  // holds keys the user just typed, so the merge preserves everything else.
  const toWrite = { ...fileKeys, ...pending };
  const wrote = Object.keys(pending).length > 0;
  if (wrote) writeKeysFile(keysFile, toWrite);

  // --- summary -------------------------------------------------------------
  io.output.write(`${divider("Summary")}\n\n`);
  if (configured.length) {
    io.output.write(`${green(`${symbol("ok")} Configured:`)} ${configured.join(", ")}\n`);
  } else {
    io.output.write(`${green(`${symbol("ok")} Configured:`)} ${dim("none")}\n`);
  }
  io.output.write(`${yellow(`${symbol("warn")} Skipped:`)} ${skipped.length ? skipped.join(", ") : dim("none")}\n\n`);

  const numeric = configured
    .map((label) => Object.values(PROVIDERS).find((s) => (s.label || "") === label))
    .filter((s) => s && typeof s.ratePerMin === "number");
  const capacity = numeric.reduce((sum, s) => sum + s.ratePerMin, 0);
  if (capacity > 0) {
    io.output.write(`Estimated capacity: ~${capacity} requests/minute across ${numeric.length} provider(s)\n`);
  }
  if (configured.some((c) => c.startsWith("Ollama"))) {
    io.output.write(`+ ${dim("unlimited local inference via Ollama")}\n`);
  }
  io.output.write("\n");

  if (wrote) {
    io.output.write(`Keys saved to: ${dim(keysFile)}\n`);
    const exportHint =
      process.platform === "win32"
        ? `Get-Content ${keysFile} | ForEach-Object { if ($_ -match '=') { $p = $_ -split '=',2; Set-Item "env:$($p[0])" $p[1] } }`
        : `source ${keysFile}`;
    io.output.write(`To use these keys, run: ${cyan(exportHint)}\n`);
    io.output.write(`Or run ${cyan("aflow setup --export")} to print export commands for your shell.\n`);
    if (process.platform === "win32") {
      io.output.write(`${yellow("Note:")} this file contains secrets; on Windows it is not restricted to your user by default.\n`);
    }
  } else {
    io.output.write(`No new keys were saved. ${dim(`(${keysFile} was not modified)`)}\n`);
  }
  io.output.write(`\nRun ${cyan("aflow doctor")} to verify everything works.\n`);

  const payload = {
    keysFile,
    configured: configured.length,
    skipped: skipped.length,
    written: wrote,
    providers: { configured, skipped },
  };
  // In JSON mode the human wizard text above still went to the injected output;
  // emit the machine summary on stdout without repeating it.
  if (out?.json) await out.init(payload, () => "");
  return 0;
}

/** Non-interactive: test every configured provider and report reachability. */
async function runCheck({ out, deps, keysFile, fetchImpl, timeoutMs, flags, config }) {
  const processEnv = deps.env || process.env;
  const merged = mergeEnv(readKeysFile(keysFile), processEnv);
  const ollamaUrl = flags["ollama-url"] ? String(flags["ollama-url"]) : config?.ollamaUrl || GATEWAY_DEFAULTS.ollamaUrl;

  const rows = [];
  const local = await checkOllama(ollamaUrl, fetchImpl, timeoutMs);
  rows.push({
    name: "ollama",
    status: local.ok ? "reachable" : "unconfigured",
    detail: local.ok ? `${(local.models || []).length} local model(s)` : local.reason,
  });

  for (const name of CLOUD_ORDER) {
    const spec = PROVIDERS[name];
    if (!providerReady(spec, merged)) continue; // only test providers that are configured
    const result = await testProvider(spec, { env: merged, fetchImpl, timeoutMs });
    rows.push({
      name: spec.label || name,
      status: result.ok ? "reachable" : "unreachable",
      detail: result.reason,
    });
  }

  const tested = rows.filter((r) => r.name !== "ollama").length;
  const failed = rows.filter((r) => r.status === "unreachable").length;
  const payload = { keysFile, tested, failed, rows };

  await out.init(payload, (r) => {
    const lines = [bold("aflow setup --check"), "", `keys file: ${dim(r.keysFile)}`];
    const rows = r.rows.map((row) => {
      const mark = row.status === "reachable" ? green(symbol("ok")) : row.status === "unconfigured" ? dim(symbol("pending")) : red(symbol("fail"));
      return {
        name: row.name,
        status: `${mark} ${row.status}`,
        detail: row.detail || row.status,
      };
    });
    if (rows.length) {
      lines.push("", table(rows, [
        { key: "name", label: "Provider" },
        { key: "status", label: "Status" },
        { key: "detail", label: "Detail" },
      ]));
    }
    if (!r.tested) lines.push("", dim("No hosted providers are configured yet — run `aflow setup`."));
    return lines.join("\n");
  });

  return failed ? 1 : 0;
}

/** Print shell export commands for the saved keys. */
async function runExport({ out, flags, keysFile }) {
  const fileKeys = readKeysFile(keysFile);
  const shell = flags.shell === "posix" || flags.shell === "powershell" ? flags.shell : undefined;
  const lines = formatExport(fileKeys, shell ? { shell } : {});
  const payload = { keysFile, count: lines.length, exports: lines };

  await out.init(payload, (r) =>
    r.exports.length
      ? r.exports.join("\n")
      : dim(`Nothing to export — no keys in ${r.keysFile}. Run \`aflow setup\` first.`)
  );
  return 0;
}

/** Delete the keys file after confirmation. */
async function runReset({ out, io, flags, keysFile }) {
  const exists = fs.existsSync(keysFile);
  if (!exists) {
    await out.init({ keysFile, reset: false, reason: "missing" }, () => dim(`No keys file at ${keysFile}.`));
    return 1;
  }

  let confirmed = flags.yes === true;
  if (!confirmed) {
    const prompter = createPrompter(io);
    try {
      const answer = await prompter.ask(`${yellow("Delete")} ${keysFile}? ${dim("[y/N]:")} `);
      if (!io.interactive) io.output.write("\n");
      confirmed = answer !== null && /^y(es)?$/i.test(answer.trim());
    } finally {
      prompter.close();
    }
  }

  if (!confirmed) {
    await out.init({ keysFile, reset: false, reason: "declined" }, () => dim("Aborted; keys kept."));
    return 1;
  }

  removeKeysFile(keysFile);
  await out.init({ keysFile, reset: true }, () => `${green(symbol("ok"))} Removed ${keysFile}`);
  return 0;
}

/**
 * The command body, factored out so tests can inject deps.
 *
 * @param {{ flags?: Record<string, unknown>, config?: object, out: object, deps?: object }} ctx
 */
export async function runSetup({ flags = {}, config = {}, out, deps = {} }) {
  const io = resolveIO(deps);
  const keysFile = resolveKeysFile(flags, deps);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS;

  try {
    const modeFlags = ["check", "test", "export", "reset"].filter((name) => flags[name]);
    if (modeFlags.length > 1) {
      throw usage(`--${modeFlags.join(" and --")} cannot be combined; pick one mode.`);
    }
    if (flags.reset) return await runReset({ out, io, flags, keysFile });
    if (flags.export) return await runExport({ out, flags, keysFile });
    if (flags.check || flags.test) return await runCheck({ out, deps, keysFile, fetchImpl, timeoutMs, flags, config });
    return await runWizard({ flags, config, out, deps, io, keysFile, fetchImpl, timeoutMs });
  } catch (err) {
    if (err.usage) {
      await out.init({ error: err.message, usage: setupCommand.usage }, () => `${err.message}\n\n${setupCommand.usage}`);
      return USAGE_ERROR;
    }
    throw err;
  }
}

export const setupCommand = defineCommand("setup", {
  summary: "configure free provider API keys with a guided wizard",
  valueFlags: ["keys-file", "ollama-url", "shell"],
  usage: `aflow setup [options]

Walks you through configuring free AI provider API keys and stores them in a
single keys.env file under your state directory, so they are never committed.

  aflow setup                 full interactive wizard (default)
  aflow setup --check         test the keys you have, changing nothing
  aflow setup --test          alias for --check
  aflow setup --export        print shell export commands for the saved keys
  aflow setup --reset         delete the saved keys (asks to confirm)

  --keys-file PATH   where to read/write keys (default: <state dir>/keys.env)
  --ollama-url URL   local Ollama base URL to probe (default http://127.0.0.1:11434)
  --shell posix|powershell   output format for --export
  --yes              skip the confirmation prompt for --reset

Keys are stored 0600 (owner-only) on Unix. process.env always takes precedence
over the file, so exporting a variable overrides the saved value.

Exit codes: 0 ok, 1 a configured key failed or reset was declined, 2 usage.`,
  run: async ({ flags = {}, config = {}, out, deps = {} }) => runSetup({ flags, config, out, deps }),
});

export default setupCommand;
