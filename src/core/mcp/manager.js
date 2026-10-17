// MCP Server Manager.
//
// Manages multiple MCP server instances: creates clients/transports from config,
// starts/stops them, and exposes aggregated tools/resources/prompts.
import { McpClient } from "./client.js";
import { McpToolBridge } from "./tools-bridge.js";
import { McpResourceManager } from "./resources.js";
import { McpPromptManager } from "./prompts.js";
import { getMcpServers } from "./config.js";

export class McpServerManager {
  constructor(options = {}) {
    this.root = options.root || process.cwd();
    this.servers = new Map(); // name -> { client, tools, resources, prompts, config }
    this._started = false;
  }

  async startAll() {
    if (this._started) return;
    const configs = getMcpServers(this.root);
    for (const cfg of configs) {
      const client = cfg.type === "sse"
        ? new McpClient({ transportType: "sse", url: cfg.url, headers: cfg.headers })
        : new McpClient({ transportType: "stdio", command: cfg.command, args: cfg.args, cwd: cfg.cwd, env: cfg.env });
      const tools = new McpToolBridge({ client, serverName: cfg.name });
      const resources = new McpResourceManager({ client });
      const prompts = new McpPromptManager({ client });
      this.servers.set(cfg.name, { client, tools, resources, prompts, config: cfg });
      try {
        await tools.initialize();
        try { await resources.listResources(); } catch { /* ignore */ }
        try { await resources.listResourceTemplates(); } catch { /* ignore */ }
        try { await prompts.listPrompts(); } catch { /* ignore */ }
      } catch {
        // ignore startup failures; remain non-blocking
      }
    }
    this._started = true;
  }

  async stopAll() {
    for (const s of this.servers.values()) {
      try { s.resources.dispose?.(); } catch { /* ignore */ }
      try { await s.client.close(); } catch { /* ignore */ }
    }
    this.servers.clear();
    this._started = false;
  }

  getServer(name) {
    return this.servers.get(name);
  }

  getAllTools() {
    const all = [];
    for (const s of this.servers.values()) {
      all.push(...s.tools.getTools());
    }
    return all;
  }

  getAllResources() {
    const all = [];
    for (const s of this.servers.values()) {
      for (const r of s.resources.resources.values()) all.push(r);
    }
    return all;
  }

  isStarted() {
    return this._started;
  }
}

export default { McpServerManager };
