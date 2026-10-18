// MCP config parser.
//
// Supports mcp.json, .agentflow/mcp.json, and package.json "mcp" key.
// Format: { "mcpServers": { "<name>": { command: string, args: string[] } | { url: string } } }
import fs from "node:fs";
import path from "node:path";

export function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    // Windows tooling (PowerShell 5's Set-Content -Encoding UTF8) writes a BOM;
    // JSON.parse rejects it, so strip it before parsing.
    const cleaned = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function findMcpConfig(root = process.cwd()) {
  const candidates = [
    path.join(root, ".agentflow", "mcp.json"),
    path.join(root, "mcp.json"),
    path.join(root, ".agentflow.mcp.json"),
    path.join(root, "package.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function parseMcpConfig(root = process.cwd()) {
  const cfgPath = findMcpConfig(root);
  if (!cfgPath) return { servers: {} };
  const raw = readJsonSafe(cfgPath);
  if (!raw) {
    // findMcpConfig only returns paths that exist, so a null read means the
    // file is present but unparseable — a diagnostic, not a crash.
    return { servers: {}, path: cfgPath, diagnostics: [`${cfgPath}: invalid JSON`] };
  }
  let servers = {};
  const diagnostics = [];
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    servers = raw.mcpServers;
  } else if (raw.mcp && typeof raw.mcp === "object" && raw.mcp.mcpServers) {
    servers = raw.mcp.mcpServers;
  } else if (path.basename(cfgPath) === "package.json") {
    diagnostics.push(`${cfgPath}: no \`mcp.mcpServers\` key — not an error`);
  }
  return { servers, path: cfgPath, diagnostics };
}

export function expandEnv(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? "");
}

export function normalizeServerConfig(name, cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  if (cfg.url) {
    return { name, type: "sse", url: expandEnv(cfg.url), headers: cfg.headers || {} };
  }
  if (cfg.command) {
    let command = cfg.command;
    let args = Array.isArray(cfg.args) ? cfg.args.map(expandEnv) : [];
    // OpenCode-compatible local form: `command: ["cmd", "arg1", ...]`.
    if (Array.isArray(command)) {
      args = command.slice(1).map(expandEnv);
      command = command[0];
    }
    return { name, type: "stdio", command: expandEnv(command), args, cwd: cfg.cwd, env: cfg.env };
  }
  return null;
}

export function getMcpServers(root = process.cwd()) {
  const { servers } = parseMcpConfig(root);
  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const norm = normalizeServerConfig(name, cfg);
    if (norm) out.push(norm);
  }
  return out;
}

export default { parseMcpConfig, findMcpConfig, getMcpServers, normalizeServerConfig, expandEnv };
