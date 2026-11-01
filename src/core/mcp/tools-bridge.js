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

  _redactSecrets(args) {
    if (typeof args !== "object" || args === null) return args;
    const redacted = { ...args };
    for (const key of Object.keys(redacted)) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token")) {
        redacted[key] = "***REDACTED***";
      }
    }
    return redacted;
  }

  _validateArgs(args, schema) {
    if (!schema) return true; // no schema = pass
    if (typeof args !== "object" || args === null) {
      throw new Error(`invalid arguments: expected object, got ${typeof args}`);
    }
    const required = schema.required || [];
    const properties = schema.properties || {};
    for (const req of required) {
      if (!(req in args)) {
        throw new Error(`missing required argument: ${req}`);
      }
    }
    for (const [key, def] of Object.entries(properties)) {
      if (key in args && def.type) {
        if (def.type === "string" && typeof args[key] !== "string") {
          throw new Error(`argument \`${key}\` expected type "string", got "${typeof args[key]}"`);
        }
        if (def.type === "number" && typeof args[key] !== "number") {
          throw new Error(`argument \`${key}\` expected type "number", got "${typeof args[key]}"`);
        }
        if (def.type === "integer" && !(typeof args[key] === "number" && Number.isInteger(args[key]))) {
          throw new Error(`argument \`${key}\` expected type "integer", got "${typeof args[key]}"`);
        }
        if (def.type === "boolean" && typeof args[key] !== "boolean") {
          throw new Error(`argument \`${key}\` expected type "boolean", got "${typeof args[key]}"`);
        }
        if (def.type === "array" && !Array.isArray(args[key])) {
          throw new Error(`argument \`${key}\` expected type "array", got "${typeof args[key]}"`);
        }
        if (def.enum && !def.enum.includes(args[key])) {
          throw new Error(`argument \`${key}\` must be one of: ${def.enum.join(", ")}`);
        }
      }
    }
    return true;
  }

  async callTool(toolName, args) {
    const entry = this.tools.get(toolName);
    if (!entry) throw new Error(`unknown tool: ${toolName}`);
    const safeArgs = this._redactSecrets(args || {});
    this._validateArgs(safeArgs, entry.inputSchema);
    const res = await this.client.request("tools/call", { name: entry.name, arguments: safeArgs });
    return res;
  }

  getTools() {
    return [...this.tools.values()];
  }
}

export default { McpToolBridge };
