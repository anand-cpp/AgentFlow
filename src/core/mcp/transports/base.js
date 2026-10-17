// MCP Transport base interface.
//
// MCP transports expose the same minimal surface: connect, send, close and
// message/error events. Implementations may be stdio (JSON-RPC line-delimited
// JSON) or HTTP/SSE (event stream + POST), but the consumer should not need
// to know which one.
export class McpTransport {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  connect() {
    throw new Error("McpTransport.connect must be implemented");
  }

  send(_message) {
    throw new Error("McpTransport.send must be implemented");
  }

  close() {}

  on(type, fn) {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(type, detail) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(detail);
      } catch {
        /* swallow listener errors */
      }
    }
  }
}

export default { McpTransport };
