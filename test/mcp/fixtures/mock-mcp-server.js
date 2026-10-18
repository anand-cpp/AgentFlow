// A minimal, deterministic MCP server used by the integration tests.
//
// Speaks JSON-RPC 2.0 over stdio (newline-delimited JSON, the canonical MCP
// transport) and implements just enough of the 2024-11-05 spec to drive every
// client path without any real MCP package installed:
//
//   tools:       echo (text back), calculator (arithmetic), explode (isError result)
//   resources:   file://test.txt (text), file://blob.bin (base64)
//   prompts:     review (a single user-role message)
//
// Bug-for-bug honesty: malformed non-request lines are ignored, unknown
// requests get a method-not-found error, and EOF after `shutdown` exits 0.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let shuttingDown = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const TOOLS = [
  {
    name: "echo",
    description: "returns its arguments joined as text",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
  },
  {
    name: "calculator",
    description: "adds or multiplies two numbers",
    inputSchema: {
      type: "object",
      required: ["a", "b", "op"],
      properties: { a: { type: "number" }, b: { type: "number" }, op: { type: "string", enum: ["+", "*"] } },
    },
  },
  {
    name: "explode",
    description: "always reports a tool-level error",
    inputSchema: { type: "object" },
  },
];

const RESOURCES = {
  "file://test.txt": { uri: "file://test.txt", mimeType: "text/plain", text: "hello from the mock resource" },
  "file://blob.bin": { uri: "file://blob.bin", mimeType: "application/octet-stream", blob: "AAECAwQ=" },
};

const PROMPTS = {
  review: {
    name: "review",
    description: "asks the model to review some code",
    arguments: [{ name: "code", required: true, description: "the code under review" }],
  },
};

function handleRequest(method, params, id) {
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false }, logging: {} },
          serverInfo: { name: "mock-mcp-server", version: "0.0.1" },
        },
      });
      return;

    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS, nextCursor: undefined } });
      return;

    case "tools/call": {
      const name = params?.name;
      if (name === "echo") {
        const message = params?.arguments?.message ?? "";
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${message}` }], isError: false } });
        return;
      }
      if (name === "calculator") {
        const { a = 0, b = 0, op = "+" } = params?.arguments ?? {};
        const value = op === "*" ? Number(a) * Number(b) : Number(a) + Number(b);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `result: ${value}` }], isError: false } });
        return;
      }
      if (name === "explode") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "the tool exploded" }], isError: true } });
        return;
      }
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
      return;
    }

    case "resources/list":
      send({ jsonrpc: "2.0", id, result: { resources: Object.values(RESOURCES) } });
      return;

    case "resources/templates/list":
      send({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } });
      return;

    case "resources/read": {
      const uri = params?.uri;
      const entry = RESOURCES[uri];
      if (!entry) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown resource: ${uri}` } });
        return;
      }
      const { uri: _u, text, ...rest } = entry;
      void _u;
      send({ jsonrpc: "2.0", id, result: { contents: [{ uri, ...(text != null ? { text } : rest) }] } });
      return;
    }

    case "prompts/list":
      send({ jsonrpc: "2.0", id, result: { prompts: Object.values(PROMPTS) } });
      return;

    case "prompts/get": {
      const name = params?.name;
      const prompt = PROMPTS[name];
      if (!prompt) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown prompt: ${name}` } });
        return;
      }
      const code = params?.arguments?.code ?? "(no code given)";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          description: prompt.description,
          messages: [
            { role: "user", content: { type: "text", text: `Review this code:\n${code}` } },
          ],
        },
      });
      return;
    }

    case "shutdown":
      shuttingDown = true;
      send({ jsonrpc: "2.0", id, result: null });
      return;

    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  if (id != null && typeof method === "string") {
    handleRequest(method, params, id);
    return;
  }
  // notifications are accepted and ignored
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // tolerate garbage rather than dying
  }
  handle(parsed);
});

rl.on("close", () => process.exit(shuttingDown ? 0 : 1));
