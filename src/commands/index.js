// Command registration.
//
// One import surface: adding a command means adding it here. The router reads
// the resulting table, so `--help` stays in sync automatically.
//
// Commands are registered as lightweight *metadata* only (name, summary,
// valueFlags). The heavy command module -- and every subsystem it pulls in
// (LSP, MCP, tribunal, PageRank, git, ...) -- is loaded on demand by
// `loadCommand`, so `aflow --version`, `--help`, and `status` never pay for
// commands the user isn't running. Each command module self-registers its full
// spec (including `run`) through `defineCommand` when it is imported.

import { defineCommandMeta, loadCommand } from "../cli/registry.js";

defineCommandMeta("agent", {
  summary: "run and inspect the built-in agents",
  valueFlags: ["task", "session", "state-dir", "blackboard-dir", "project", "workspace", "log-file"],
});
defineCommandMeta("blackboard", {
  summary: "record and recover durable project workflow state",
  valueFlags: [
    "goal", "objective", "project", "state-dir", "limit", "status", "detail",
    "kind", "rationale", "alternatives", "supersedes", "severity", "source",
    "author", "files", "commit", "session", "task", "depends", "suite",
    "command", "passed", "failed", "skipped", "verdict", "confirm",
  ],
});
defineCommandMeta("chat", {
  summary: "interactive chat with streaming, sessions, and provider failover",
  valueFlags: [
    "resume", "model", "agent", "project", "workspace", "state-dir",
    "blackboard-dir", "log-file", "message",
  ],
});
defineCommandMeta("config", {
  summary: "show effective configuration and where each value came from",
});
defineCommandMeta("dashboard", {
  summary: "open the interactive terminal dashboard",
  valueFlags: ["interval"],
});
defineCommandMeta("doctor", {
  summary: "check environment, gateway, and live provider reachability",
  valueFlags: ["log-file"],
});
defineCommandMeta("git", {
  summary: "inspect and drive the repository: status, log, diff, branch, stage, commit, stash, conflicts",
  valueFlags: ["project", "path", "limit", "message"],
});
defineCommandMeta("init", {
  summary: "create a starter project config",
});
defineCommandMeta("lsp", {
  summary: "query a language server: status, diagnostics, hover, definition",
  valueFlags: ["project"],
});
defineCommandMeta("logs", {
  summary: "read the structured event log",
  valueFlags: ["limit", "level", "since", "type", "file"],
});
defineCommandMeta("map", {
  summary: "show the PageRank-ranked structural map of this workspace",
  valueFlags: ["project"],
});
defineCommandMeta("mcp", {
  summary: "inspect and invoke Model Context Protocol servers",
  valueFlags: ["project"],
});
defineCommandMeta("models", {
  summary: "list models by provider, optionally probing reachability",
  valueFlags: ["limit"],
});
defineCommandMeta("plugin", {
  summary: "list, inspect, enable, disable and scaffold plugins",
  valueFlags: ["project"],
});
defineCommandMeta("publish", {
  summary: "check distribution readiness before an npm publish (never publishes)",
});
defineCommandMeta("server", {
  summary: "run and control the standalone in-repo gateway",
  valueFlags: ["host", "ollama-url", "state-dir", "keys-file", "models-cache-ms"],
});
defineCommandMeta("route", {
  summary: "run a completion through the fallback cascade",
  valueFlags: ["fallback", "log-file"],
});
defineCommandMeta("sessions", {
  summary: "start, resume, and inspect persistent sessions",
  valueFlags: ["objective", "name", "project", "limit", "entries", "state-dir", "agents", "provider", "id", "as"],
});
defineCommandMeta("setup", {
  summary: "configure free provider API keys with a guided wizard",
  valueFlags: ["keys-file", "ollama-url", "shell"],
});
defineCommandMeta("status", {
  summary: "show gateway health and version",
});
defineCommandMeta("tribunal", {
  summary: "run the five-stage self-adversarial tribunal on a proposal",
  valueFlags: ["prompt", "domain", "models", "model", "limit", "retries", "state-dir", "project", "record", "tribunal"],
});
defineCommandMeta("fight", {
  summary: "alias for: aflow tribunal run",
  valueFlags: ["prompt", "domain", "models", "model", "limit", "retries", "state-dir", "project", "record", "tribunal"],
});

export { loadCommand };
export { defineCommand, getCommand, getCommands, commandNames, valueFlagNames } from "../cli/registry.js";
