// MCP Prompt template discovery and expansion.
//
// Discovers and fetches prompt templates from MCP servers.
export class McpPromptManager {
  constructor(options = {}) {
    this.client = options.client;
    this.prompts = new Map();
  }

  async listPrompts(cursor = null) {
    const params = cursor ? { cursor } : {};
    const res = await this.client.request("prompts/list", params);
    const list = Array.isArray(res?.prompts) ? res.prompts : [];
    for (const p of list) {
      if (p?.name) this.prompts.set(p.name, p);
    }
    if (res?.nextCursor) {
      await this.listPrompts(res.nextCursor);
    }
    return this.prompts;
  }

  async getPrompt(name, args) {
    return this.client.request("prompts/get", { name, arguments: args || {} });
  }

  getPrompts() {
    return [...this.prompts.values()];
  }
}

export default { McpPromptManager };
