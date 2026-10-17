// MCP Resource reader and template engine.
//
// Handles resource discovery (list, templates), reading with URI support,
// and caches. Also listens for resource update notifications.
export class McpResourceManager {
  constructor(options = {}) {
    this.client = options.client;
    this.resources = new Map();
    this.templates = new Map();
    this._cache = new Map();
    this._onNotify = (msg) => this._handleNotification(msg);
    this._unsub = this.client.on("notification", this._onNotify);
  }

  _handleNotification(msg) {
    if (!msg || typeof msg.method !== "string") return;
    if (msg.method === "notifications/resources/updated") {
      const uri = msg.params?.uri;
      if (uri) this._cache.delete(uri);
    }
  }

  async listResources(cursor = null) {
    const params = cursor ? { cursor } : {};
    const res = await this.client.request("resources/list", params);
    const list = Array.isArray(res?.resources) ? res.resources : [];
    for (const r of list) {
      if (r?.uri) this.resources.set(r.uri, r);
    }
    if (res?.nextCursor) {
      await this.listResources(res.nextCursor);
    }
    return this.resources;
  }

  async listResourceTemplates(cursor = null) {
    const params = cursor ? { cursor } : {};
    const res = await this.client.request("resources/templates/list", params);
    const list = Array.isArray(res?.resourceTemplates) ? res.resourceTemplates : [];
    for (const t of list) {
      if (t?.uriTemplate) this.templates.set(t.uriTemplate, t);
    }
    if (res?.nextCursor) {
      await this.listResourceTemplates(res.nextCursor);
    }
    return this.templates;
  }

  async readResource(uri) {
    if (this._cache.has(uri)) return this._cache.get(uri);
    const res = await this.client.request("resources/read", { uri });
    this._cache.set(uri, res);
    return res;
  }

  clear() {
    this._cache.clear();
  }

  dispose() {
    if (this._unsub) this._unsub();
  }
}

export default { McpResourceManager };
