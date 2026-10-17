// HTTP/SSE MCP transport.
//
// MCP servers may expose SSE at GET /sse and accept JSON-RPC requests at a
// POST endpoint returned in the `endpoint` event. This implementation uses
// Node's http/https modules only (no external deps).
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { McpTransport } from "./base.js";

export class SseTransport extends McpTransport {
  constructor(options = {}) {
    const { url, headers = {}, requestTimeoutMs = 10000 } = options;
    if (!url) throw new Error("SseTransport requires a url");
    super();
    this.url = url;
    this.headers = headers;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sseReq = null;
    this.postUrl = null;
    this.connected = false;
    this.buf = "";
    this.eventBuf = "";
    this.currentEvent = "";
  }

  connect() {
    if (this.connected) return;
    const u = new URL(this.url);
    const client = u.protocol === "https:" ? https : http;
    const req = client.request(u, {
      method: "GET",
      headers: { "Accept": "text/event-stream", "Cache-Control": "no-cache", ...this.headers },
    });
    this.sseReq = req;
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => this._onSse(chunk));
      res.on("error", (err) => this.emit("error", { type: "sse", err }));
      res.on("end", () => {
        this.emit("exit", { code: 0 });
        this.connected = false;
      });
    });
    req.on("error", (err) => this.emit("error", { type: "sse_req", err }));
    req.end();
  }

  _onSse(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (line === "") {
        // dispatch event
        this._dispatchEvent();
        this.currentEvent = "";
        this.eventBuf = "";
        continue;
      }
      if (line.startsWith(":")) continue; // comment
      if (line.startsWith("event:")) {
        this.currentEvent = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        this.eventBuf += (this.eventBuf ? "\n" : "") + line.slice("data:".length).trim();
        continue;
      }
    }
  }

  _dispatchEvent() {
    const data = this.eventBuf;
    const event = this.currentEvent;
    if (event === "endpoint") {
      try {
        const u = new URL(this.url);
        const ep = new URL(data.startsWith("/") ? data : "/" + data, u.origin);
        this.postUrl = ep.toString();
        this.connected = true;
        this.emit("open", { postUrl: this.postUrl });
      } catch (err) {
        this.emit("error", { type: "endpoint", err, data });
      }
      return;
    }
    if (data) {
      try {
        const msg = JSON.parse(data);
        this.emit("message", msg);
      } catch (err) {
        this.emit("error", { type: "parse", err, data, event });
      }
    }
  }

  send(message) {
    if (!this.postUrl) throw new Error("SSE transport not ready (no endpoint)");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const u = new URL(this.postUrl);
    const client = u.protocol === "https:" ? https : http;
    const req = client.request(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        ...this.headers,
      },
    });
    const timer = setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
    }, this.requestTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("response", (res) => {
      res.resume();
      res.on("end", () => {
        clearTimeout(timer);
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        this.emit("error", { type: "post_resp", err });
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      this.emit("error", { type: "post_req", err });
    });
    req.write(body);
    req.end();
  }

  close() {
    try {
      this.sseReq?.destroy();
    } catch { /* ignore */ }
    this.connected = false;
  }
}

export default { SseTransport };
