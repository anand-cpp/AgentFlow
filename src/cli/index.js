// Command router.
//
// Design (see AUDIT/OPENCODE_STUDY.md §3.4): commands are looked up in a table
// by name rather than dispatched through an if/else chain, so `--help` output,
// completion, and dispatch all read from one source of truth.
//
// AgentFlow deliberately does not adopt a DI framework or plugin runtime yet.
// The table is plain data; that is enough until plugins exist, and it keeps
// `aflow --help` instant.

import { Output } from "./output.js";
import { getCommand, getCommands } from "./registry.js";
import { resolveConfig } from "../config/index.js";
import { setColor, bold, dim } from "./ui.js";

// Command storage lives in ./registry.js. Keeping it separate avoids an import
// cycle: commands import the registry, and this router imports the registry.
/** Global flags recognised before the command name. */
const GLOBAL_FLAGS = new Set([
  "help", "h", "version", "v", "json", "quiet", "verbose", "debug",
  "no-color", "port", "model", "base-url",
]);

/**
 * Split argv into global flags and the command + its args.
 * Global flags may appear before or after the command name.
 */
export function parseArgv(argv) {
  const flags = {};
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let key = a.slice(2);
      let val = null;
      const eq = key.indexOf("=");
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (val === null) {
        // Boolean flags never consume the next token; value flags do.
        if (["port", "model", "base-url"].includes(key) && i + 1 < argv.length) {
          val = argv[++i];
        } else {
          val = true;
        }
      }
      flags[key] = val;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const map = { h: "help", v: "version", q: "quiet", p: "port" };
      const key = map[a.slice(1)] || a.slice(1);
      let val = true;
      if (["port", "model", "base-url"].includes(key) && i + 1 < argv.length) {
        val = argv[++i];
      }
      flags[key] = val;
    } else {
      rest.push(a);
    }
  }

  const commandName = rest.shift() || null;
  return { commandName, args: rest, flags };
}

function renderVersion(config) {
  return `${bold("aflow")} ${VERSION}\n${dim("terminal-first AI routing and agent platform")}`;
}

function renderHelp(commands) {
  const lines = [];
  lines.push(bold("aflow") + dim(" — terminal-first AI routing and agent platform"));
  lines.push("");
  lines.push(bold("USAGE"));
  lines.push("  aflow <command> [options]");
  lines.push("");
  lines.push(bold("COMMANDS"));
  const width = Math.max(...commands.map((c) => c.name.length));
  for (const c of commands) {
    lines.push(`  ${c.name.padEnd(width)}  ${dim(c.summary)}`);
  }
  lines.push("");
  lines.push(bold("GLOBAL FLAGS"));
  lines.push(`  ${"--json".padEnd(width)}  ${dim("emit machine-readable JSON on stdout")}`);
  lines.push(`  ${"--quiet".padEnd(width)}  ${dim("suppress non-essential output")}`);
  lines.push(`  ${"--verbose".padEnd(width)}  ${dim("include diagnostic detail")}`);
  lines.push(`  ${"--no-color".padEnd(width)}  ${dim("disable ANSI colour")}`);
  lines.push(`  ${"--port".padEnd(width)}  ${dim("gateway port (default 20127)")}`);
  lines.push(`  ${"--model".padEnd(width)}  ${dim("default model id")}`);
  lines.push(`  ${"--base-url".padEnd(width)}  ${dim("gateway base URL")}`);
  lines.push("");
  lines.push(bold("CONFIG PRECEDENCE") + dim("  low → high"));
  lines.push(dim("  defaults < global file < project file < AGENTFLOW_* env < flags"));
  lines.push("");
  return lines.join("\n");
}

export const VERSION = "0.1.0";

export async function run(argv) {
  const { commandName, args, flags } = parseArgv(argv);

  if (flags["no-color"] || flags.color === false) setColor(false);
  else if (process.env.NO_COLOR !== undefined) setColor(false);

  const { config, diagnostics } = resolveConfig({ flags });
  const out = new Output({ json: config.json, quiet: config.quiet, verbose: config.verbose });

  for (const d of diagnostics) out.warn(dim(`config: ${d}`));

  if (flags.version && !commandName) {
    await out.init({ version: VERSION }, renderVersion);
    return 0;
  }

  if (!commandName || flags.help === true) {
    const target = commandName ? getCommand(commandName) : null;
    if (commandName && !target) {
      out.error(`unknown command: ${commandName}`);
      out.error(dim(`run \`aflow --help\` to list commands`));
      return 127;
    }
    await out.init(
      { commands: getCommands().map((c) => ({ name: c.name, summary: c.summary })) },
      () => (target?.usage ? `${target.usage}\n` : renderHelp(getCommands()))
    );
    return 0;
  }

  const cmd = getCommand(commandName);
  if (!cmd) {
    out.error(`unknown command: ${commandName}`);
    out.error(dim(`run \`aflow --help\` to list commands`));
    return 127;
  }

  try {
    const code = await cmd.run({ args, flags, config, out });
    return typeof code === "number" ? code : 0;
  } catch (err) {
    if (out.json) {
      process.stdout.write(`${JSON.stringify({ error: err.message, code: err.code ?? null }, null, 2)}\n`);
    } else {
      out.error(`${commandName}: ${err.message}`);
      if (config.verbose && err.stack) out.detail(err.stack);
    }
    return 1;
  }
}

export { GLOBAL_FLAGS };
export default { run, getCommands, parseArgv };