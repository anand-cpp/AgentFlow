// Command palette — fuzzy-searchable command launcher for the AgentFlow TUI.
//
// Press Ctrl+P (or /) to open, type to filter, Enter to execute.
// Commands are defined with real handlers that integrate with AgentFlow's
// existing subsystems: sessions, models, agents, themes, tribunal, blackboard,
// git, mcp, plugins, settings.

import { filterFuzzy } from "./interact.js";
import { drawBox, drawInput } from "./components.js";
import { paintToken } from "./theme-engine.js";
import { dim } from "../cli/ui.js";

/** A command palette entry. */
export class PaletteCommand {
  constructor({ id, label, description, handler, category, shortcut, disabled = false }) {
    this.id = id;
    this.label = label;
    this.description = description;
    this.handler = handler;
    this.category = category;
    this.shortcut = shortcut;
    this.disabled = disabled;
  }
}

/** Built-in command palette commands. */
export function createDefaultCommands(ctx = {}) {

  return [
    new PaletteCommand({
      id: "new-session",
      label: "New Session",
      description: "Start a fresh conversation session",
      category: "session",
      shortcut: "Ctrl+N",
      handler: () => { ctx.onNewSession?.(); return "new-session"; },
    }),
    new PaletteCommand({
      id: "switch-session",
      label: "Switch Session",
      description: "Resume a previous conversation",
      category: "session",
      shortcut: "Ctrl+S",
      handler: () => { ctx.onSwitchSession?.(); return "switch-session"; },
    }),
    new PaletteCommand({
      id: "switch-model",
      label: "Switch Model",
      description: "Change the active AI model",
      category: "model",
      shortcut: "Ctrl+M",
      handler: () => { ctx.onSwitchModel?.(); return "switch-model"; },
    }),
    new PaletteCommand({
      id: "switch-agent",
      label: "Switch Agent",
      description: "Change the active agent mode",
      category: "agent",
      shortcut: "Ctrl+A",
      handler: () => { ctx.onSwitchAgent?.(); return "switch-agent"; },
    }),
    new PaletteCommand({
      id: "switch-theme",
      label: "Switch Theme",
      description: "Change the TUI color theme",
      category: "theme",
      shortcut: "Ctrl+T",
      handler: () => { ctx.onSwitchTheme?.(); return "switch-theme"; },
    }),
    new PaletteCommand({
      id: "tribunal",
      label: "Run Tribunal",
      description: "Five-stage adversarial review of a proposal",
      category: "tribunal",
      shortcut: "Ctrl+R",
      handler: () => { ctx.onTribunal?.(); return "tribunal"; },
    }),
    new PaletteCommand({
      id: "blackboard",
      label: "Open Blackboard",
      description: "View project goal, tasks, and decisions",
      category: "project",
      shortcut: "Ctrl+B",
      handler: () => { ctx.onBlackboard?.(); return "blackboard"; },
    }),
    new PaletteCommand({
      id: "repo-map",
      label: "Repository Map",
      description: "View PageRank-ranked code structure",
      category: "project",
      shortcut: "Ctrl+P",
      handler: () => { ctx.onRepoMap?.(); return "repo-map"; },
    }),
    new PaletteCommand({
      id: "git-status",
      label: "Git Status",
      description: "View working tree and branch state",
      category: "git",
      shortcut: "Ctrl+G",
      handler: () => { ctx.onGit?.(); return "git-status"; },
    }),
    new PaletteCommand({
      id: "mcp-servers",
      label: "MCP Servers",
      description: "Manage Model Context Protocol connections",
      category: "tools",
      shortcut: "Ctrl+C",
      handler: () => { ctx.onMcp?.(); return "mcp-servers"; },
    }),
    new PaletteCommand({
      id: "plugins",
      label: "Plugins",
      description: "Manage AgentFlow plugins",
      category: "tools",
      shortcut: "Ctrl+L",
      handler: () => { ctx.onPlugins?.(); return "plugins"; },
    }),
    new PaletteCommand({
      id: "settings",
      label: "Settings",
      description: "Configure AgentFlow preferences",
      category: "system",
      shortcut: "Ctrl+,",
      handler: () => { ctx.onSettings?.(); return "settings"; },
    }),
    new PaletteCommand({
      id: "doctor",
      label: "Doctor",
      description: "Check environment and provider health",
      category: "system",
      shortcut: "Ctrl+D",
      handler: () => { ctx.onDoctor?.(); return "doctor"; },
    }),
    new PaletteCommand({
      id: "hackathon",
      label: "Hackathon Mode",
      description: "Coordinate agents across multiple computers",
      category: "system",
      shortcut: "Ctrl+H",
      handler: () => { ctx.onHackathon?.(); return "hackathon"; },
    }),
    new PaletteCommand({
      id: "quit",
      label: "Quit",
      description: "Exit AgentFlow",
      category: "system",
      shortcut: "Ctrl+Q",
      handler: () => { ctx.onQuit?.(); return "quit"; },
    }),
  ];
}

/**
 * Render the command palette overlay.
 *
 * @param {Array<PaletteCommand>} commands  Filtered command list
 * @param {number} selectedIndex
 * @param {string} query
 * @param {object} opts { width, height }
 * @returns {string}
 */
export function renderPalette(commands, selectedIndex, query, opts = {}) {
  const { width: w = 80, height: h = 24 } = opts;
  const lines = [];

  // Title
  lines.push(paintToken("Command Palette", "accent", "bold"));
  lines.push("");

  // Search input
  const inputLine = drawInput("search", query, query.length, { width: w - 4 });
  lines.push(inputLine);
  lines.push("");

  // Results
  const visible = commands.slice(0, h - 8);
  if (visible.length === 0) {
    lines.push(dim("No matching commands"));
  } else {
    for (let i = 0; i < visible.length; i += 1) {
      const cmd = visible[i];
      const isSelected = i === selectedIndex;
      const marker = isSelected ? "▸ " : "  ";
      const disabled = cmd.disabled ? " (disabled)" : "";
      const shortcut = cmd.shortcut ? `  ${dim(cmd.shortcut)}` : "";
      const desc = cmd.description ? `  ${dim(cmd.description)}` : "";

      let text = `${marker}${cmd.label}${desc}${shortcut}${disabled}`;
      if (isSelected) {
        lines.push(paintToken(text, "accent", "bold"));
      } else if (cmd.disabled) {
        lines.push(dim(text));
      } else {
        lines.push(text);
      }
    }
  }

  lines.push("");
  lines.push(dim("↑↓ navigate · Enter execute · Esc cancel · type to filter"));

  return drawBox("Command Palette", lines.join("\n"), {
    width: Math.min(w, 70),
    borderColor: "accent",
    titleColor: "accent",
    padding: 1,
  });
}

/**
 * Filter commands by fuzzy query, grouped by category.
 *
 * @param {Array<PaletteCommand>} commands
 * @param {string} query
 * @returns {Array<PaletteCommand>}
 */
export function filterCommands(commands, query) {
  if (!query) return commands;
  return filterFuzzy(commands, query, "label");
}
