// `aflow mcp` and the `/mcp` chat slash.
//
// Front door for MCP server operations: inspect configured servers, list
// discovered tools, invoke a tool manually, and read a resource. Each
// invocation starts the servers, performs the operation, and stops them —
// a one-shot pattern like `aflow lsp`, so nothing keeps running unless a
// caller (the agent runtime) explicitly holds the manager.

import path from "node:path";
import { defineCommand } from "../cli/registry.js";
import { McpServerManager } from "../core/mcp/manager.js";
import { getMcpServers, normalizeServerConfig } from "../core/mcp/config.js";
import { bold, dim, green, heading, red, yellow } from "../cli/ui.js";

const FAILURE = 1;

/** Render `aflow mcp status`: configured servers and discovery results. */
function renderStatus(configured, manager) {
  const lines = [heading("mcp servers")];
  if (!configured.length) {
    lines.push(yellow("no MCP servers configured — add mcp.json or .agentflow/mcp.json"));
    return lines.join("\n");
  }
  const rows = manager.servers;
  for (const cfg of configured) {
    const entry = rows.get(cfg.name);
    if (entry) {
      const tools = entry.tools.getTools();
      const resources = entry.resources.resources.size;
      lines.push(`${bold(cfg.name)} ${green("connected")} ${dim(entry.config.type)} ${tools.length} tools, ${resources} resources`);
      for (const t of tools.slice(0, 10)) {
        lines.push(`  ${dim(`mcp__${cfg.name}__${t.name}`)}${t.description ? " " + dim(t.description.slice(0, 72)) : ""}`);
      }
      if (tools.length > 10) lines.push(dim(`  …and ${tools.length - 10} more`));
    } else {
      lines.push(`${bold(cfg.name)} ${red("failed")} ${dim(cfg.type)}`);
    }
  }
  return lines.join("\n");
}

/** Render `aflow mcp tools`: every named tool across every server. */
function renderTools(manager) {
  const all = manager.getAllTools();
  if (!all.length) return yellow("no MCP tools discovered");
  return all
    .map((t) => {
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : "{}";
      return `${bold(t.fullName)} ${dim(t.description ?? "")}\n  ${dim("schema: " + schema)}`;
    })
    .join("\n");
}

/**
 * Shared dispatcher behind the CLI command and the /mcp slash.
 *
 * @param {string} root
 * @param {string[]} tokens
 * @returns {Promise<{ ok: boolean, text: string, data: any }>}
 */
export async function dispatchMcp(root, tokens) {
  const [sub = "status", ...rest] = tokens;
  const configured = getMcpServers(root).map(normalizeServerConfig);

  if (sub === "help" || sub === "--help") {
    return { ok: true, text: mcpCommand.usage, data: { usage: mcpCommand.usage } };
  }

  if (!["status", "list", "tools", "call", "read"].includes(sub)) {
    return { ok: false, text: red(`unknown mcp subcommand: ${sub}`), data: { error: `unknown subcommand: ${sub}` } };
  }

  if (!configured.length) {
    return { ok: false, text: yellow("no MCP servers configured — add mcp.json with an `mcpServers` block"), data: { error: "no servers configured" } };
  }

  if (sub === "call" && rest.length < 2) {
    return { ok: false, text: red("call requires <server> <tool> [jsonArgs]"), data: { error: "missing arguments" } };
  }
  if (sub === "read" && rest.length < 2) {
    return { ok: false, text: red("read requires <server> <uri>"), data: { error: "missing arguments" } };
  }

  const manager = new McpServerManager({ root });
  try {
    await manager.startAll();

    if (sub === "status" || sub === "list") {
      return { ok: true, text: renderStatus(configured, manager), data: { servers: configured } };
    }
    if (sub === "tools") {
      return { ok: true, text: renderTools(manager), data: { tools: manager.getAllTools() } };
    }
    if (sub === "call") {
      const [serverName, toolName, jsonArgs = "{}"] = rest;
      const entry = manager.getServer(serverName);
      if (!entry) return { ok: false, text: red(`no MCP server named ${serverName}`), data: { error: "unknown server" } };
      let args;
      try {
        args = JSON.parse(jsonArgs);
      } catch (err) {
        return { ok: false, text: red(`jsonArgs is not valid JSON: ${err.message}`), data: { error: `invalid JSON: ${err.message}` } };
      }
      const namespaced = `mcp__${serverName}__${toolName}`;
      let res;
      try {
        res = await entry.tools.callTool(namespaced, args);
      } catch (err) {
        return { ok: false, text: red(`${toolName} failed: ${err.message}`), data: { error: err.message } };
      }
      if (res?.isError) {
        const text = (res.content || []).map((c) => c?.text ?? "").filter(Boolean).join("\n") || "tool reported an error";
        return { ok: false, text: red(`${toolName} reported an error: ${text}`), data: { error: text } };
      }
      const text = (res?.content || []).map((c) => c?.text ?? "").filter(Boolean).join("\n");
      return { ok: true, text: text || dim("(no output)"), data: { result: res } };
    }
    if (sub === "read") {
      const [serverName, uri] = rest;
      const entry = manager.getServer(serverName);
      if (!entry) return { ok: false, text: red(`no MCP server named ${serverName}`), data: { error: "unknown server" } };
      let res;
      try {
        res = await entry.resources.readResource(uri);
      } catch (err) {
        return { ok: false, text: red(`read failed: ${err.message}`), data: { error: err.message } };
      }
      const contents = Array.isArray(res?.contents) ? res.contents : [];
      const text = contents.map((c) => (typeof c.text === "string" ? c.text : `[${c.mimeType ?? "binary"} blob]`)).join("\n");
      return { ok: true, text: text || dim("(empty resource)"), data: { resource: res } };
    }

    return { ok: false, text: red(`unknown mcp subcommand: ${sub}`), data: { error: `unknown subcommand: ${sub}` } };
  } catch (err) {
    const message = err?.message ?? String(err);
    return { ok: false, text: red(`mcp ${sub} failed: ${message}`), data: { error: message } };
  } finally {
    await manager.stopAll().catch(() => {});
  }
}

/**
 * The chat `/mcp` handler.
 * @param {string} arg text after /mcp
 * @param {{ root: string }} opts
 * @returns {Promise<string>}
 */
export async function mcpSlash(arg, { root }) {
  const tokens = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const result = await dispatchMcp(root, tokens);
  return result.text;
}

export const mcpCommand = defineCommand("mcp", {
  summary: "inspect and invoke Model Context Protocol servers",
  valueFlags: ["project"],
  usage: `aflow mcp status
  aflow mcp tools
  aflow mcp call <server> <tool> [jsonArgs]
  aflow mcp read <server> <uri>

Reads mcp.json (or .agentflow/mcp.json) from the project directory, starts
every configured server (stdio or SSE), discovers its tools and resources,
performs the requested operation, then shuts everything down.

Inside a chat, the same dispatcher is reachable as /mcp <subcommand>.

  --project PATH   resolve config relative to another directory
  --json           machine-readable output

Exit codes: 0 ok, 1 an mcp failure, 2 usage.`,
  run: async ({ args, flags, out }) => {
    const root = flags && flags.project ? path.resolve(String(flags.project)) : process.cwd();
    const result = await dispatchMcp(root, args || []);
    await out.init(result.data, () => result.text);
    return result.ok ? 0 : FAILURE;
  },
});

export default mcpCommand;
