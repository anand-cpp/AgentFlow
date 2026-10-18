// MCP agent bridge: connects the server manager to the agent runtime.
//
// Wraps MCP tools in AgentFlow's internal tool schema shape, namespaced as
// `mcp__<server>__<toolName>`, so the runtime's tool map can hold them next to
// real tools with no special path in `runRequestedTools`. Everything is
// defensive: a server that fails to start or a tool that fails must never fail
// the run itself.
import { TOOL_SCOPE } from "../agents/registry.js";

export function isMcpToolName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

/** Extract the server and raw tool name from a namespaced MCP tool name. */
export function parseMcpToolName(name) {
  if (!isMcpToolName(name)) return null;
  const parts = name.slice("mcp__".length).split("__");
  if (parts.length < 2) return null;
  const tool = parts.pop();
  return { server: parts.join("__"), tool };
}

/** Map an MCP tools/call content array to readable text. */
export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "image") parts.push(`[image: ${c.mimeType ?? "unknown"}]`);
    else if (c.type === "resource") parts.push(`[resource: ${c.uri ?? "unknown"}]`);
    else if (typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n");
}

/**
 * Adapt one discovered MCP tool into the AgentFlow tool shape.
 * MCP tools are read-implied unless their schema suggests mutation; keep them
 * on the READ scope and let the agent's policy decide.
 */
export function adaptTool(entry) {
  return {
    name: entry.fullName,
    scope: TOOL_SCOPE.READ,
    description: `[mcp:${entry.server}] ${entry.description || entry.name}`,
    inputSchema: entry.inputSchema || { type: "object", properties: {} },
    resultSchema: { type: "object" },
    failureBehavior: { TOOL_ERROR: "error" },
    limits: {},
    redaction: "None: output comes from the MCP server.",
    events: ["tool.call", "tool.error"],
    async execute(args = {}) {
      const res = await entry.bridge.callTool(entry.fullName, args);
      if (res?.isError) {
        throw new Error(contentToText(res?.content) || "MCP tool reported an error");
      }
      return { text: contentToText(res?.content), raw: res };
    },
    // metadata so runtime bridge can route back
    _mcp: { server: entry.server, tool: entry.name, bridge: entry.bridge },
  };
}

export class McpAgentBridge {
  /**
   * @param {{ manager?: import("./manager.js").McpServerManager|null }} options
   */
  constructor({ manager = null } = {}) {
    this.manager = manager;
  }

  /** Discover tools from every running server, wrapped in the runtime schema. */
  async discoverTools() {
    if (!this.manager) return new Map();
    await this.manager.startAll();
    const map = new Map();
    for (const tool of this.manager.getAllTools()) {
      const server = this.manager.getServer(tool.server);
      if (!server) continue;
      map.set(tool.fullName, adaptTool({ ...tool, bridge: server.tools }));
    }
    return map;
  }

  /** Execute a namespaced MCP tool. */
  async callTool(name, args) {
    const server = this.findServerForTool(name);
    if (!server) throw new Error(`no MCP server provides ${name}`);
    const res = await server.tools.callTool(name, args);
    if (res?.isError) throw new Error(contentToText(res?.content) || "MCP tool reported an error");
    return contentToText(res?.content);
  }

  findServerForTool(name) {
    if (!this.manager) return null;
    for (const s of this.manager.servers.values()) {
      if (s.tools.tools.has(name)) return s;
    }
    return null;
  }

  /** Register discovered tools onto a runtime's tool map. */
  registerTools(runtime) {
    const discovered = this._discovered;
    if (!discovered) return 0;
    for (const [name, tool] of discovered) runtime.tools.set(name, tool);
    return discovered.size;
  }

  /** Cache discovered tools so registerTools() can work synchronously. */
  async refresh(runtime) {
    this._discovered = await this.discoverTools();
    return this.registerTools(runtime ?? { tools: new Map() });
  }

  async stop() {
    try { await this.manager?.stopAll?.(); } catch { /* ignore */ }
  }
}

export default { McpAgentBridge, isMcpToolName, parseMcpToolName, contentToText, adaptTool };
