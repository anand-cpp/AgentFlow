// MCP Tool discovery and execution bridge.
//
// Discovers MCP tools via `tools/list` (with pagination), parses definitions,
// and exposes execution via `callTool`. AgentFlow tools are namespaced as
// `mcp__<serverName>__<toolName>` to avoid collisions.
export class McpToolBridge {
  constructor(options = {}) {
    this.client = options.client;
    this.serverName = options.serverName || "mcp";
    this.tools = new Map();
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return this.tools;
    await this.client.initialize();
    await this.listAllTools();
    this._initialized = true;
    return this.tools;
  }

  async listAllTools(cursor = null) {
    const params = cursor ? { cursor } : {};
    const res = await this.client.request("tools/list", params);
    const list = Array.isArray(res?.tools) ? res.tools : [];
    for (const t of list) {
      const name = t?.name;
      if (typeof name === "string") {
        const full = `mcp__${this.serverName}__${name}`;
        this.tools.set(full, { name, fullName: full, description: t.description, inputSchema: t.inputSchema, server: this.serverName });
      }
    }
    if (res?.nextCursor) {
      await this.listAllTools(res.nextCursor);
    }
    return this.tools;
  }

  async callTool(toolName, args) {
    const entry = this.tools.get(toolName);
    if (!entry) throw new Error(`unknown tool: ${toolName}`);
    const res = await this.client.request("tools/call", { name: entry.name, arguments: args || {} });
    return res;
  }

  getTools() {
    return [...this.tools.values()];
  }
}

export default { McpToolBridge };
