// LSP tools for the agent runtime.
//
// Four read-scoped tools the model can call when a language server is running:
// ask for diagnostics, hover, a definition, or the server's status. They are a
// feedback loop, not a control surface -- none of them mutate anything, so they
// are safe to expose wherever `read` is granted.
//
// `registerLspTools(runtime)` attaches them to a runtime's tool map. It is a
// separate registration rather than an entry in REAL_TOOLS because the LSP
// tools only exist when a server is configured, and because the real-tools list
// is a frozen contract (REAL_TOOL_NAMES) that must not change shape when a
// language server happens to be installed.

import path from "node:path";
import { TOOL_SCOPE } from "../agents/registry.js";
import { TOOL_ERROR, ToolInvocationError } from "../agents/tool-errors.js";
import { getHover, getDefinition } from "./capabilities.js";

export const LSP_TOOL_NAMES = ["lsp.status", "lsp.diagnostics", "lsp.hover", "lsp.definition"];

/**
 * Resolve a tool argument to an absolute path inside the workspace.
 * @param {string} target
 * @param {string} root
 */
function resolveInRoot(target, root) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(target ?? ""));
  const rel = path.relative(base, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolInvocationError(TOOL_ERROR.PATH_OUTSIDE_WORKSPACE, `path is outside the workspace: ${target}`, {
      path: target,
    });
  }
  return abs;
}

/** Human-facing relative path for a result. */
function rel(file, root) {
  return path.relative(root, file) || file;
}

/**
 * @param {{ bridge?: import("./agent-bridge.js").LspAgentBridge|null }} options
 */
export function createLspTools({ bridge = null } = {}) {
  const root = bridge?.root ?? process.cwd();

  const requireActive = () => {
    if (!bridge || !bridge.active) {
      throw new ToolInvocationError(TOOL_ERROR.INTERNAL_ERROR, "no language server is running for this workspace");
    }
    return bridge;
  };

  return [
    {
      name: "lsp.status",
      scope: TOOL_SCOPE.READ,
      description:
        "Report whether a language server is running, its name and capabilities, and the number of current errors.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      resultSchema: {
        type: "object",
        properties: {
          active: { type: "boolean" },
          server: { type: "string", nullable: true },
          capabilities: { type: "array", items: { type: "string" } },
          errorCount: { type: "integer" },
        },
      },
      failureBehavior: { NONE: "never fails; reports active: false when no server is running" },
      limits: {},
      redaction: "None: only server metadata.",
      events: ["tool.call", "tool.denied", "tool.error"],

      async execute() {
        const b = bridge ?? null;
        if (!b) return { active: false, server: null, capabilities: [], errorCount: 0 };
        const active = b.active;
        const server = active ? b.client?.serverInfo?.name ?? "language server" : null;
        const capabilities = active ? Object.keys(b.client?.capabilities ?? {}) : [];
        const errorCount = b.diagnostics?.getErrors().length ?? 0;
        return { active, server, capabilities, errorCount };
      },
    },
    {
      name: "lsp.diagnostics",
      scope: TOOL_SCOPE.READ,
      description:
        "Get language-server diagnostics. With a path, re-analyses that file and returns its diagnostics; without one, returns every error in the workspace.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file to analyse. Omit for all current errors." },
        },
      },
      resultSchema: {
        type: "object",
        properties: {
          file: { type: "string", nullable: true },
          count: { type: "integer" },
          diagnostics: { type: "array" },
        },
      },
      failureBehavior: { NO_SERVER: "error (no language server is running)" },
      limits: { maxDiagnostics: 200 },
      redaction: "None needed: diagnostics come from the server, not from file contents.",
      events: ["tool.call", "tool.denied", "tool.error"],

      async execute(args = {}, ctx = {}) {
        const b = requireActive();
        const base = ctx.workspaceRoot ?? b.root ?? root;
        let list;
        let file = null;
        if (args.path) {
          const abs = resolveInRoot(args.path, base);
          file = path.relative(base, abs) || abs;
          await b.refresh(abs);
          list = b.diagnostics.diagnosticsForFile(abs);
        } else {
          list = b.diagnostics.getAll();
        }
        const bounded = list.slice(0, 200).map((d) => ({
          file: path.relative(base, d.file) || d.file,
          line: d.range.start.line + 1,
          character: d.range.start.character + 1,
          severity: d.severity,
          code: d.code,
          message: d.message,
        }));
        return { file, count: bounded.length, diagnostics: bounded };
      },
    },
    {
      name: "lsp.hover",
      scope: TOOL_SCOPE.READ,
      description: "Ask the language server for hover information (type, docs) at a position.",
      inputSchema: {
        type: "object",
        required: ["path", "line", "character"],
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file." },
          line: { type: "integer", minimum: 1, description: "1-based line number." },
          character: { type: "integer", minimum: 1, description: "1-based column number." },
        },
      },
      resultSchema: {
        type: "object",
        properties: { contents: { type: "string", nullable: true } },
      },
      failureBehavior: { NO_SERVER: "error (no language server is running)", NO_INFO: "returns contents: null" },
      limits: { timeoutMs: 5000 },
      redaction: "None needed: hover text comes from the server.",
      events: ["tool.call", "tool.denied", "tool.error"],

      async execute(args = {}, ctx = {}) {
        const b = requireActive();
        const base = ctx.workspaceRoot ?? b.root ?? root;
        const abs = resolveInRoot(args.path, base);
        b.openDocument(abs);
        const text = await getHover(b.client, abs, Number(args.line) - 1, Number(args.character) - 1);
        return { path: rel(abs, base), contents: text };
      },
    },
    {
      name: "lsp.definition",
      scope: TOOL_SCOPE.READ,
      description: "Ask the language server where the symbol at a position is defined.",
      inputSchema: {
        type: "object",
        required: ["path", "line", "character"],
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file." },
          line: { type: "integer", minimum: 1, description: "1-based line number." },
          character: { type: "integer", minimum: 1, description: "1-based column number." },
        },
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer" }, locations: { type: "array" } },
      },
      failureBehavior: { NO_SERVER: "error (no language server is running)", NOT_FOUND: "empty locations, not an error" },
      limits: { maxLocations: 50 },
      redaction: "None needed: locations are paths and ranges.",
      events: ["tool.call", "tool.denied", "tool.error"],

      async execute(args = {}, ctx = {}) {
        const b = requireActive();
        const base = ctx.workspaceRoot ?? b.root ?? root;
        const abs = resolveInRoot(args.path, base);
        b.openDocument(abs);
        const locations = await getDefinition(b.client, abs, Number(args.line) - 1, Number(args.character) - 1);
        const bounded = locations.slice(0, 50).map((loc) => ({
          file: path.relative(base, loc.file) || loc.file,
          line: loc.line + 1,
          character: loc.character + 1,
        }));
        return { count: bounded.length, locations: bounded };
      },
    },
  ];
}

/**
 * Register the LSP tools on a runtime's tool map.
 *
 * @param {{ tools: Map<string, any>, lspBridge?: import("./agent-bridge.js").LspAgentBridge|null }} runtime
 * @param {{ bridge?: import("./agent-bridge.js").LspAgentBridge|null }} [options]
 */
export function registerLspTools(runtime, { bridge } = {}) {
  const b = bridge ?? runtime.lspBridge ?? null;
  const tools = createLspTools({ bridge: b });
  for (const tool of tools) runtime.tools.set(tool.name, tool);
  return tools;
}

export default { createLspTools, registerLspTools, LSP_TOOL_NAMES };
