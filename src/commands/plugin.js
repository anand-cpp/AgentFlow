// `aflow plugin` and the `/plugin` chat slash.
//
// Front door for plugin management: list what discovery found, inspect one
// plugin in detail (loading it so its real registrations are visible), toggle
// it on or off, and scaffold a new one.
//
// The trust line is deliberate: `list`, `inspect` and the toggle all load or
// read plugin code the same way `aflow chat` does, so what this command
// reports is what a session will actually get. `create` writes a template and
// evaluates nothing.

import fs from "node:fs";
import path from "node:path";

import { defineCommand } from "../cli/registry.js";
import { bold, dim, green, heading, red, table, yellow } from "../cli/ui.js";
import { PluginManager } from "../core/plugins/manager.js";
import {
  discoverPlugins,
  setPluginEnabled,
  workspacePluginsDir,
} from "../core/plugins/discovery.js";
import { MANIFEST_FILE } from "../core/plugins/manifest.js";
import { RESERVED_COMMANDS } from "../core/chat.js";
import { VERSION } from "../core/version.js";

const FAILURE = 1;
const USAGE = 2;

const SUBCOMMANDS = ["list", "inspect", "enable", "disable", "create", "help"];

/** One line per permission, so a wide grant is impossible to miss. */
function permissionLine(perms) {
  const entries = Object.entries(perms || {});
  const granted = entries.filter(([, v]) => v !== false && !(Array.isArray(v) && v.length === 0));
  if (granted.length === 0) return dim("permissions: none");
  return (
    "permissions: " +
    granted
      .map(([k, v]) => (Array.isArray(v) ? `${k}[${v.length}]` : bold(k)))
      .join(", ")
  );
}

/** Render `aflow plugin list`. */
function renderList(manager, discovered) {
  const lines = [heading("plugins")];
  if (discovered.length === 0) {
    lines.push(yellow("no plugins discovered"));
    lines.push(dim(`  drop one in ${workspacePluginsDir(manager.workspaceRoot)}`));
    lines.push(dim("  or run `aflow plugin create <id>` to scaffold one"));
    return lines.join("\n");
  }

  const stats = manager.stats();
  const byId = new Map(stats.loaded.map((p) => [p.id, p]));

  const rows = discovered.map((spec) => {
    const loaded = byId.get(spec.id);
    return {
      id: spec.id,
      version: spec.version ?? dim("-"),
      source: spec.source ?? dim("?"),
      status: spec.status,
      adds: loaded
        ? [loaded.tools.length && `${loaded.tools.length} tool(s)`,
            loaded.commands.length && `${loaded.commands.length} cmd(s)`,
            loaded.providers.length && `${loaded.providers.length} provider(s)`,
            loaded.contexts.length && `${loaded.contexts.length} ctx(s)`,
            loaded.hooks.length && `${loaded.hooks.length} hook(s)`]
            .filter(Boolean)
            .join(" ") || dim("nothing")
        : dim("(not loaded)"),
    };
  });

  lines.push(
    table(rows, [
      { key: "id", label: "id" },
      { key: "version", label: "version" },
      { key: "source", label: "source" },
      { key: "status", label: "status" },
      { key: "adds", label: "adds" },
    ])
  );

  const problems = stats.problems.filter((p) => p.id !== "discovery");
  if (problems.length > 0) {
    lines.push("");
    lines.push(yellow(`${problems.length} plugin(s) reported problems:`));
    for (const p of problems) {
      for (const line of p.lines) lines.push(`  ${red(p.id)}: ${line}`);
    }
  }
  const discovery = stats.problems.find((p) => p.id === "discovery");
  if (discovery) {
    lines.push("");
    for (const line of discovery.lines) lines.push(dim(`  ${line}`));
  }
  return lines.join("\n");
}

/** Render `aflow plugin inspect <id>`. */
function renderInspect(manager, spec, stats) {
  const loaded = stats.loaded.find((p) => p.id === spec.id);
  const problems = stats.problems.find((p) => p.id === spec.id);

  const lines = [heading(`${spec.id}`)];
  lines.push(`name:        ${spec.name ?? dim("(none)")}`);
  lines.push(`version:     ${spec.version ?? dim("(none)")}`);
  lines.push(`author:      ${spec.author ?? dim("(none)")}`);
  lines.push(`description: ${spec.description ?? dim("(none)")}`);
  lines.push(`source:      ${spec.source ?? dim("?")} ${dim(spec.dir)}`);
  lines.push(`status:      ${spec.status}`);
  lines.push(permissionLine(spec.permissions));
  if (spec.minAgentFlowVersion) {
    lines.push(
      `requires:    AgentFlow >= ${spec.minAgentFlowVersion} (running ${VERSION}) ${spec.versionOk ? green("ok") : red("too old")}`
    );
  }

  if (spec.status !== "enabled") {
    lines.push("");
    lines.push(yellow(`not loaded: status is ${spec.status}`));
    return { text: lines.join("\n"), ok: spec.status !== "invalid" };
  }
  if (!loaded) {
    lines.push("");
    lines.push(yellow("not loaded: the plugin failed to activate"));
    for (const line of problems?.lines ?? []) lines.push(`  ${red(line)}`);
    return { text: lines.join("\n"), ok: false };
  }

  lines.push("");
  lines.push(`format:      ${loaded.format} ${dim(`(load ${loaded.initMs}ms)`)}`);
  const named = (label, items, pick) =>
    items.length ? lines.push(`${label.padEnd(12)}${items.map(pick).join(dim(", "))}`) : lines.push(`${label.padEnd(12)}${dim("(none)")}`);
  named("hooks:", loaded.hooks, (h) => h);
  named("tools:", loaded.tools, (t) => t);
  named("providers:", loaded.providers, (p) => p);
  named("commands:", loaded.commands, (c) => `/${c}`);
  named("contexts:", loaded.contexts, (c) => c);

  if (loaded.commands.length) {
    lines.push("");
    lines.push(dim("  plugin commands are reserved: a plugin may not shadow a builtin such as /quit or /model"));
  }

  const plugin = manager.loaded.get(spec.id);
  const logLines = plugin?.log?.lines ?? [];
  if (logLines.length) {
    lines.push("");
    lines.push(`${bold("log")} ${dim(`(last ${Math.min(logLines.length, 10)} of ${logLines.length})`)}`);
    for (const line of logLines.slice(-10)) {
      const paint = line.level === "error" ? red : dim;
      lines.push(`  ${paint(`(${line.level})`)} ${line.message}`);
    }
  }

  const diags = [...(problems?.lines ?? []), ...(spec.errors ?? [])];
  if (diags.length) {
    lines.push("");
    lines.push(yellow("problems:"));
    for (const line of diags) lines.push(`  ${red(line)}`);
    return { text: lines.join("\n"), ok: false };
  }
  return { text: lines.join("\n"), ok: true };
}

/** Write a scaffolded plugin. Evaluates nothing. */
function scaffoldPlugin(root, id) {
  const dir = path.join(workspacePluginsDir(root), id);
  if (fs.existsSync(dir)) {
    return { ok: false, error: `${dir} already exists` };
  }
  const manifest = {
    id,
    name: id,
    version: "0.1.0",
    description: `AgentFlow plugin ${id}`,
    main: "index.js",
    minAgentFlowVersion: VERSION,
    permissions: { hooks: true, tools: true, commands: false, providers: false },
  };
  const entry = `// ${id} — an AgentFlow plugin.
//
// activate(ctx) runs inside a sandbox: \`require\` is limited to node:events and
// console is captured into this plugin's own log ring. Registering something
// the manifest did not declare is refused, and any throw here is isolated --
// it costs this plugin, never the session.

module.exports = function activate(ctx) {
  // Observe a run before it starts. Return \`{ extra }\` to add context the
  // agent will see, or \`{ deny: true, reason }\` to refuse the run outright.
  ctx.on("beforeAgentRun", function (payload) {
    void payload;
  });

  // Observe a tool call before the permission waterfall judges it.
  ctx.on("beforeToolExecute", function (payload) {
    void payload;
  });

  // Tools are namespaced to \`plugin__${id}__<name>\` so they can never collide
  // with a builtin. The default scope is \`read\`, the most conservative one.
  ctx.registerTool({
    name: "echo",
    description: "Echo the given text back (replace with a real tool).",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async function (args) {
      return { echo: args && args.text ? String(args.text) : "" };
    },
  });
};
`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "index.js"), entry, "utf8");
    return { ok: true, dir, files: [MANIFEST_FILE, "index.js"] };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * Shared dispatcher behind the CLI command and the /plugin slash.
 *
 * @param {string} root workspace/project root
 * @param {string[]} tokens subcommand and its arguments
 * @returns {Promise<{ ok: boolean, text: string, data: object }>}
 */
export async function dispatchPlugin(root, tokens) {
  const [sub = "list", ...rest] = tokens;

  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { ok: true, text: pluginCommand.usage, data: { usage: pluginCommand.usage } };
  }
  if (!SUBCOMMANDS.includes(sub)) {
    return {
      ok: false,
      text: red(`unknown plugin subcommand: ${sub}`) + "\n" + dim(`try: ${SUBCOMMANDS.join(", ")}`),
      data: { error: `unknown subcommand: ${sub}` },
    };
  }

  if (sub === "create") {
    const id = String(rest[0] ?? "").trim();
    if (!id) {
      return { ok: false, text: red("create requires <id>"), data: { error: "missing id" } };
    }
    const res = scaffoldPlugin(root, id);
    if (!res.ok) {
      return { ok: false, text: red(`create failed: ${res.error}`), data: { error: res.error } };
    }
    return {
      ok: true,
      text: [
        green(`created ${id} in ${res.dir}`),
        dim(`  ${res.files.join(", ")}`),
        dim("  it is enabled by default; `aflow plugin disable <id>` turns it off"),
        dim("  `aflow plugin inspect " + id + "` loads it and shows what it registered"),
      ].join("\n"),
      data: { id, dir: res.dir, files: res.files },
    };
  }

  if (sub === "enable" || sub === "disable") {
    const id = String(rest[0] ?? "").trim();
    if (!id) {
      return { ok: false, text: red(`${sub} requires <id>`), data: { error: "missing id" } };
    }
    const { plugins } = discoverPlugins({ workspaceRoot: root, currentVersion: VERSION });
    const spec = plugins.find((p) => p.id === id);
    if (!spec) {
      const known = plugins.map((p) => p.id);
      return {
        ok: false,
        text: red(`no plugin named ${id}`) + (known.length ? `\n${dim(`known: ${known.join(", ")}`)}` : ""),
        data: { error: "unknown plugin", known },
      };
    }
    const want = sub === "enable";
    const res = setPluginEnabled(id, want, root);
    if (!res.ok) {
      return { ok: false, text: red(`could not write plugin state: ${res.error}`), data: { error: res.error } };
    }
    return {
      ok: true,
      text: `${want ? green("enabled") : yellow("disabled")} ${bold(id)} ${dim(`(state: ${path.join(root, ".agentflow", "plugins.json")})`)}`,
      data: { id, enabled: want },
    };
  }

  // list and inspect both load, so the report matches what a session gets.
  const manager = new PluginManager({
    workspaceRoot: root,
    currentVersion: VERSION,
    builtinCommands: RESERVED_COMMANDS,
  });
  try {
    await manager.init();
    const stats = manager.stats();
    const discovered = manager.discovered;

    if (sub === "list") {
      return { ok: true, text: renderList(manager, discovered), data: { plugins: discovered, stats } };
    }

    const id = String(rest[0] ?? "").trim();
    if (!id) {
      return { ok: false, text: red("inspect requires <id>"), data: { error: "missing id" } };
    }
    const spec = discovered.find((p) => p.id === id);
    if (!spec) {
      const known = discovered.map((p) => p.id);
      return {
        ok: false,
        text: red(`no plugin named ${id}`) + (known.length ? `\n${dim(`known: ${known.join(", ")}`)}` : ""),
        data: { error: "unknown plugin", known },
      };
    }
    const rendered = renderInspect(manager, spec, stats);
    return { ok: rendered.ok, text: rendered.text, data: { plugin: spec, stats } };
  } catch (err) {
    const message = err?.message ?? String(err);
    return { ok: false, text: red(`plugin ${sub} failed: ${message}`), data: { error: message } };
  } finally {
    await manager.shutdown().catch(() => {});
  }
}

/**
 * The chat `/plugin` handler.
 * @param {string} arg text after /plugin
 * @param {{ root: string }} opts
 * @returns {Promise<string>}
 */
export async function pluginSlash(arg, { root }) {
  const tokens = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const result = await dispatchPlugin(root, tokens);
  return result.text;
}

export const pluginCommand = defineCommand("plugin", {
  summary: "list, inspect, enable, disable and scaffold plugins",
  valueFlags: ["project"],
  usage: `aflow plugin list
  aflow plugin inspect <id>
  aflow plugin enable <id>
  aflow plugin disable <id>
  aflow plugin create <id>

Plugins are directories carrying an ${MANIFEST_FILE} manifest. Discovery looks
in <workspace>/.agentflow/plugins, the user-wide config plugins directory, and
node_modules for packages named agentflow-plugin-*. Enable/disable state is
stored in <workspace>/.agentflow/plugins.json.

\`list\` and \`inspect\` load plugins so the report matches what a session
actually gets; a plugin that fails to activate shows its diagnostics rather
than disappearing.

Inside a chat, the same dispatcher is reachable as /plugin <subcommand>.

  --project PATH   resolve the workspace relative to another directory
  --json           machine-readable output

Exit codes: 0 ok, 1 a plugin problem, 2 usage.`,
  run: async ({ args, flags, out }) => {
    const root = flags && flags.project ? path.resolve(String(flags.project)) : process.cwd();
    const tokens = Array.isArray(args) ? args : [];
    if (tokens.length === 0) tokens.push("list");
    if (!SUBCOMMANDS.includes(tokens[0])) {
      await out.init({ error: `unknown subcommand: ${tokens[0]}` }, () => red(`unknown plugin subcommand: ${tokens[0]}`));
      return USAGE;
    }
    const result = await dispatchPlugin(root, tokens);
    await out.init(result.data, () => result.text);
    return result.ok ? 0 : FAILURE;
  },
});

export default pluginCommand;
