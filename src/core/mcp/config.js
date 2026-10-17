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
    const parsed = JSON.parse(raw);
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
  if (!raw) return { servers: {} };
  let servers = {};
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    servers = raw.mcpServers;
  } else if (raw.mcp && typeof raw.mcp === "object" && raw.mcp.mcpServers) {
    servers = raw.mcp.mcpServers;
  }
  return { servers, path: cfgPath };
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
    const args = Array.isArray(cfg.args) ? cfg.args.map(expandEnv) : [];
    return { name, type: "stdio", command: expandEnv(cfg.command), args, cwd: cfg.cwd, env: cfg.env };
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
