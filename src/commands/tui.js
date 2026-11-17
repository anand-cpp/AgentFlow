// `aflow tui` — launch the interactive full-screen terminal workspace.
//
// Hand-rolled ANSI application with zero runtime dependencies.
// Multi-region layout: header, sidebar, conversation, inspector, prompt.
// Command palette (Ctrl+P), theme switching (Ctrl+T), slash commands (/).
// Inspector includes real security panel and TODO panel wired to live
// orchestrator and todo engine state.

import { defineCommand } from "../cli/registry.js";
import { Output } from "../cli/output.js";
import { bold, dim, red } from "../cli/ui.js";
import {
  renderWorkspaceLines,
  initialWorkspaceState,
} from "../tui/workspace.js";
import { terminalDims } from "../tui/layout.js";
import { setTheme, listThemeIds, getActiveTheme } from "../tui/theme-engine.js";
import { selectFromList, textInput, confirm } from "../tui/interact.js";
import {
  createDefaultCommands,
  renderPalette,
  filterCommands,
  PaletteCommand,
} from "../tui/command-palette.js";
import { SecurityOrchestrator, SCAN_PROFILES } from "../security/orchestrator.js";
import { SemgrepScanner } from "../security/scanners/semgrep.js";
import { OsvScanner } from "../security/scanners/osv.js";
import { TrivyScanner } from "../security/scanners/trivy.js";
import { TodoEngine } from "../security/todo.js";

const TTY = process.stdout.isTTY && process.stdin.isTTY;

export async function run({ args, flags, config, out }) {
  if (!TTY) {
    out.error("aflow tui requires an interactive terminal (stdout is not a TTY)");
    out.error(dim("Use `aflow chat`, `aflow route`, `aflow doctor`, etc. instead."));
    return 2;
  }

  // Build the real security orchestrator with all registered scanners
  const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
  orch.registerScanner(new SemgrepScanner());
  orch.registerScanner(new OsvScanner());
  orch.registerScanner(new TrivyScanner());

  // Build the real todo engine linked to the orchestrator
  const todoEngine = new TodoEngine({ securityOrchestrator: orch });

  // Generate an initial backend-style task list so the TODO panel has content
  const taskList = todoEngine.generateTaskList("backend", {
    source: "cli",
    projectRoot: process.cwd(),
  });

  const state = initialWorkspaceState();
  state.securityOrchestrator = orch;
  state.todoEngine = todoEngine;

  // Initialize command palette with real handlers
  const ctx = {
    onNewSession: () => {
      state.messages = [];
      state.currentSessionId = null;
      state.notifications.push({ message: "New session started", variant: "success" });
      state.paletteOpen = false;
      state.paletteQuery = "";
    },
    onSwitchModel: () => { state.notifications.push({ message: "Model picker coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onSwitchAgent: () => { state.notifications.push({ message: "Agent picker coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onSwitchTheme: () => {
      const ids = listThemeIds();
      selectFromList(
        ids.map((id) => ({ label: id, value: id })),
        { title: "Select theme" }
      ).then((selected) => { if (selected) setTheme(selected); state.paletteOpen = false; state.paletteQuery = ""; draw(); });
    },
    onTribunal: () => { state.notifications.push({ message: "Tribunal: connect a provider to run", variant: "warn" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onBlackboard: () => { state.notifications.push({ message: "Blackboard panel coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onRepoMap: () => { state.notifications.push({ message: "Repo map coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onGit: () => { state.notifications.push({ message: "Git panel coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onMcp: () => { state.notifications.push({ message: "MCP panel coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onPlugins: () => { state.notifications.push({ message: "Plugins panel coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onSettings: () => { state.notifications.push({ message: "Settings coming soon", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onDoctor: () => { state.notifications.push({ message: "Run: aflow doctor", variant: "info" }); state.paletteOpen = false; state.paletteQuery = ""; },
    onQuit: () => { running = false; process.stdout.write("\u001b[?1049l\u001b[?25h\u001b[0m"); process.exit(0); },
  };

  state.paletteCommands = createDefaultCommands(ctx);

  // Enter alt-screen mode, hide cursor
  process.stdout.write("\u001b[?1049h\u001b[2J\u001b[?25l");

  let running = true;

  const draw = () => {
    const lines = renderWorkspaceLines(state, dims);
    process.stdout.write("\u001b[H" + lines.join("\n"));
  };

  draw();

  const readline = await import("node:readline");
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on("keypress", (str, key) => {
    if (!running) return;

    // Quit: Escape or Ctrl+C
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (state.paletteOpen) {
        state.paletteOpen = false;
        state.paletteQuery = "";
        draw();
        return;
      }
      running = false;
      process.stdout.write("\u001b[?1049l\u001b[?25h\u001b[0m");
      process.exit(0);
      return;
    }

    // Command palette: Ctrl+P
    if (key.ctrl && key.name === "p") {
      state.paletteOpen = true;
      state.paletteQuery = "";
      state.paletteIndex = 0;
      draw();
      return;
    }

    // Theme switcher: Ctrl+T
    if (key.ctrl && key.name === "t") {
      const ids = listThemeIds();
      selectFromList(
        ids.map((id) => ({ label: id, value: id })),
        { title: "Select theme" }
      ).then((selected) => { if (selected) setTheme(selected); state.paletteOpen = false; state.paletteQuery = ""; draw(); });
      return;
    }

    // Help: F1
    if (key.name === "f1") {
      state.notifications.push({
        message: "Help: Ctrl+P palette · Ctrl+T themes · / commands · Ctrl+Q quit · F1 help",
        variant: "info",
      });
      draw();
      return;
    }

    // Security scan: Ctrl+S
    if (key.ctrl && key.name === "s") {
      orch.runProfile("standard", process.cwd()).then((session) => {
        state.notifications.push({
          message: `Security scan complete: ${session.findingsSummary.total} findings`,
          variant: session.findingsSummary.critical + session.findingsSummary.high > 0 ? "error" : "info",
        });
        draw();
      });
      return;
    }

    // Palette is open — handle its input
    if (state.paletteOpen) {
      // Navigation
      if (key.name === "up") {
        state.paletteIndex = Math.max(0, state.paletteIndex - 1);
        draw();
        return;
      }
      if (key.name === "down") {
        const cmds = filterCommands(state.paletteCommands, state.paletteQuery);
        state.paletteIndex = Math.min(cmds.length - 1, state.paletteIndex + 1);
        draw();
        return;
      }
      // Enter: execute selected command
      if (key.name === "return") {
        const cmds = filterCommands(state.paletteCommands, state.paletteQuery);
        const selected = cmds[state.paletteIndex];
        if (selected && !selected.disabled) {
          const result = selected.handler();
          state.paletteOpen = false;
          state.paletteQuery = "";
          state.paletteIndex = 0;
          if (result === "quit") return;
          draw();
        }
        return;
      }
      // Backspace
      if (key.name === "backspace") {
        state.paletteQuery = (state.paletteQuery || "").slice(0, -1);
        state.paletteIndex = 0;
        draw();
        return;
      }
      // Printable character
      if (str && str.length === 1 && str >= " ") {
        state.paletteQuery = (state.paletteQuery || "") + str;
        state.paletteIndex = 0;
        draw();
        return;
      }
      draw();
      return;
    }

    // Normal input mode
    if (str === "/") {
      state.filterText = "/";
      draw();
      return;
    }

    if (key.name === "backspace") {
      state.filterText = (state.filterText || "").slice(0, -1);
      draw();
      return;
    }

    if (key.name === "return") {
      const raw = (state.filterText || "").trim();
      state.filterText = "";
      if (!raw) { draw(); return; }

      if (raw.startsWith("/")) {
        handleSlashCommand(raw.slice(1));
      } else if (raw) {
        state.notifications.push({ message: `Sent: ${raw}`, variant: "info" });
        state.messages.push({ role: "user", content: raw });
        state.messages.push({
          role: "assistant",
          content: `Received: "${raw}" (connect a provider to enable model responses)`,
        });
      }
      draw();
      return;
    }

    if (str && str.length === 1 && str >= " ") {
      state.filterText = (state.filterText || "") + str;
      draw();
      return;
    }

    draw();
  });

  function handleSlashCommand(cmd) {
    const parts = cmd.split(/\s+/);
    const name = parts[0];

    switch (name) {
      case "help":
        state.notifications.push({
          message: "Commands: /new /sessions /models /agents /themes /settings /status /quit /scan",
          variant: "info",
        });
        break;
      case "new":
        state.messages = [];
        state.currentSessionId = null;
        state.notifications.push({ message: "New session started", variant: "success" });
        break;
      case "sessions":
        state.notifications.push({
          message: `Sessions: ${state.sessions.length} (${state.currentSessionId || "none"})`,
          variant: "info",
        });
        break;
      case "models":
        state.notifications.push({ message: `Model: ${state.currentModelId || "default"}`, variant: "info" });
        break;
      case "agents":
        state.notifications.push({ message: `Agent: ${state.currentAgentId}`, variant: "info" });
        break;
      case "themes": {
        const ids = listThemeIds();
        selectFromList(
          ids.map((id) => ({ label: id, value: id })),
          { title: "Select theme" }
        ).then((selected) => { if (selected) setTheme(selected); draw(); });
        break;
      }
      case "settings":
        state.notifications.push({ message: "Settings panel coming soon", variant: "info" });
        break;
      case "status":
        state.notifications.push({ message: "Gateway: offline · Provider keys: unconfigured", variant: "warn" });
        break;
      case "scan": {
        orch.runProfile("standard", process.cwd()).then((session) => {
          state.notifications.push({
            message: `Security scan: ${session.findingsSummary.total} findings (c:${session.findingsSummary.critical} h:${session.findingsSummary.high})`,
            variant: session.findingsSummary.critical + session.findingsSummary.high > 0 ? "error" : "info",
          });
          draw();
        });
        break;
      }
      case "quit":
        running = false;
        process.stdout.write("\u001b[?1049l\u001b[?25h\u001b[0m");
        process.exit(0);
        break;
      default:
        state.notifications.push({ message: `Unknown command: /${cmd}`, variant: "error" });
    }
  }

  return 0;
}

defineCommand("tui", {
  summary: "launch the interactive full-screen terminal workspace",
  run,
});

export default { run };
