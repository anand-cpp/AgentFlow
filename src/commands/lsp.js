// `aflow lsp` and the `/lsp` chat slash.
//
// A thin front door onto the LSP core: start a server for one file, ask one
// question, stop. This is deliberately a one-shot tool rather than a daemon --
// the interactive feedback loop lives in the agent runtime, where a server
// stays warm across a task. Here the job is "I want to know what the compiler
// thinks about this file right now", and paying the start-up cost is fine.

import fs from "node:fs";
import path from "node:path";

import { defineCommand } from "../cli/registry.js";
import { LspClient, pathToUri } from "../core/lsp/client.js";
import { LspDiagnosticsManager, severityLabel } from "../core/lsp/diagnostics.js";
import { getHover, getDefinition } from "../core/lsp/capabilities.js";
import { getServerForFile, detectInstalledServers } from "../core/lsp/registry.js";
import { bold, cyan, dim, green, heading, red, yellow } from "../cli/ui.js";

const FAILURE = 1;

function renderStatus(servers) {
  const lines = [heading("lsp servers")];
  for (const s of servers) {
    const mark = s.installed ? green("installed") : dim("missing");
    lines.push(`${bold(s.id.padEnd(12))} ${mark.padEnd(18)} ${dim(s.command)}`);
    if (!s.installed) lines.push(`  ${dim("install: " + s.install)}`);
  }
  const ready = servers.filter((s) => s.installed).length;
  lines.push("");
  lines.push(ready ? green(`${ready} of ${servers.length} server(s) available`) : yellow("no language servers found on PATH"));
  return lines.join("\n");
}

/**
 * Resolve a file argument to a registered server and an absolute path.
 * @param {string} file
 * @param {string} root
 */
export function resolveServer(file, root) {
  if (!file) return { ok: false, error: "a file path is required" };
  const abs = path.resolve(root, file);
  const server = getServerForFile(abs);
  if (!server) {
    const ext = path.extname(abs);
    return { ok: false, error: `no language server is registered for ${ext || "this file"}` };
  }
  return { ok: true, abs, server };
}

/**
 * Start a server for one file, run a callback, always shut it down.
 * @param {{ command: string, args: string[], id: string }} server
 * @param {string} root
 * @param {(session: { client: any, diagnostics: any }) => Promise<any>} fn
 */
export async function withServer(server, root, fn) {
  const client = new LspClient({ server: { command: server.command, args: server.args }, rootPath: root });
  const diagnostics = new LspDiagnosticsManager(client);
  try {
    await client.start();
    return await fn({ client, diagnostics });
  } finally {
    await diagnostics.dispose();
    await client.stop();
  }
}

async function ensureInstalled(server) {
  const all = await detectInstalledServers();
  const found = all.find((s) => s.id === server.id);
  if (found && found.installed) return { ok: true, path: found.path };
  return { ok: false, error: `${server.command} is not installed — ${server.install}` };
}

function renderDiagnostics(list, rel) {
  if (!list.length) return green("no diagnostics");
  return list
    .map((d) => {
      const where = cyan(`${rel(d.file)}:${d.range.start.line + 1}:${d.range.start.character + 1}`);
      const sev = d.severity === 1 ? red(severityLabel(d.severity)) : yellow(severityLabel(d.severity));
      return `${where} ${sev} ${d.message}`;
    })
    .join("\n");
}

/**
 * The shared dispatcher behind the CLI command and the /lsp slash.
 * @param {string} root
 * @param {string[]} tokens
 * @returns {Promise<{ ok: boolean, text: string, data: any }>}
 */
export async function dispatchLsp(root, tokens) {
  const [sub = "status", ...rest] = tokens;
  const rel = (abs) => path.relative(root, abs) || abs;

  if (sub === "status") {
    const servers = await detectInstalledServers();
    return { ok: true, text: renderStatus(servers), data: { servers } };
  }

  if (sub === "help" || sub === "--help") {
    return { ok: true, text: lspCommand.usage, data: { usage: lspCommand.usage } };
  }

  if (!["diagnostics", "hover", "definition"].includes(sub)) {
    return { ok: false, text: red(`unknown lsp subcommand: ${sub}`), data: { error: `unknown subcommand: ${sub}` } };
  }

  const line = Number(rest[1]);
  const column = Number(rest[2]);
  if (sub !== "diagnostics" && (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1)) {
    return { ok: false, text: red(`${sub} requires <file> <line> <column>, both 1-based`), data: { error: "missing position" } };
  }

  const target = resolveServer(rest[0], root);
  if (!target.ok) return { ok: false, text: red(target.error), data: { error: target.error } };

  const installed = await ensureInstalled(target.server);
  if (!installed.ok) return { ok: false, text: red(installed.error), data: { error: installed.error } };

  try {
    if (sub === "diagnostics") {
      const list = await withServer(target.server, root, async ({ client, diagnostics }) => {
        client.didOpen(target.abs, fs.readFileSync(target.abs, "utf8"));
        return diagnostics.waitFor(pathToUri(target.abs), { timeoutMs: 1500 });
      });
      return { ok: true, text: renderDiagnostics(list, rel), data: { file: rel(target.abs), diagnostics: list } };
    }

    if (sub === "hover") {
      const text = await withServer(target.server, root, ({ client }) => {
        client.didOpen(target.abs, fs.readFileSync(target.abs, "utf8"));
        return getHover(client, target.abs, line - 1, column - 1);
      });
      return {
        ok: true,
        text: text || dim("no hover information"),
        data: { file: rel(target.abs), contents: text },
      };
    }

    if (sub === "definition") {
      const locations = await withServer(target.server, root, ({ client }) => {
        client.didOpen(target.abs, fs.readFileSync(target.abs, "utf8"));
        return getDefinition(client, target.abs, line - 1, column - 1);
      });
      const out = locations.map((l) => ({ file: rel(l.file), line: l.line + 1, character: l.character + 1 }));
      const text = out.length
        ? out.map((l) => `${cyan(l.file)}:${l.line}:${l.character}`).join("\n")
        : dim("no definition found");
      return { ok: true, text, data: { count: out.length, locations: out } };
    }

    return { ok: false, text: red(`unknown lsp subcommand: ${sub}`), data: { error: `unknown subcommand: ${sub}` } };
  } catch (err) {
    const message = err?.message ?? String(err);
    return { ok: false, text: red(`lsp ${sub} failed: ${message}`), data: { error: message } };
  }
}

/**
 * The chat `/lsp` handler.
 * @param {string} arg text after /lsp
 * @param {{ root: string }} opts
 * @returns {Promise<string>}
 */
export async function lspSlash(arg, { root }) {
  const tokens = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const result = await dispatchLsp(root, tokens);
  return result.text;
}

export const lspCommand = defineCommand("lsp", {
  summary: "query a language server: status, diagnostics, hover, definition",
  valueFlags: ["project"],
  usage: `aflow lsp status
  aflow lsp diagnostics <file>
  aflow lsp hover <file> <line> <column>
  aflow lsp definition <file> <line> <column>

Start the registered language server for a file, ask one question, and stop it.
Lines and columns are 1-based. Servers are looked up by file extension; a
missing server reports its install command.

Inside a chat, the same dispatcher is reachable as /lsp <subcommand>.

  --project PATH   resolve files relative to another directory
  --json           machine-readable output

Exit codes: 0 ok, 1 an lsp failure, 2 usage.`,
  run: async ({ args, flags, out }) => {
    const root = flags && flags.project ? path.resolve(String(flags.project)) : process.cwd();
    const result = await dispatchLsp(root, args || []);
    await out.init(result.data, () => result.text);
    return result.ok ? 0 : FAILURE;
  },
});

export default lspCommand;
