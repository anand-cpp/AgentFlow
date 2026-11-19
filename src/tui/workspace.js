// AgentFlow interactive workspace — full-screen terminal UI.
//
// Renders a multi-region layout: header, sidebar, main conversation area,
// inspector panel, and prompt composer. Driven by application state and
// re-rendered on input, resize, and runtime events.
//
// Zero runtime dependencies: hand-rolled ANSI rendering only.

import { dim, cyan, gray, green, red, yellow, width, truncate, pad } from "../cli/ui.js";
import { drawInput } from "./components.js";
import { computeLayout, REGIONS } from "./layout.js";
import { getActiveTheme, paintToken } from "./theme-engine.js";
import { renderPalette, filterCommands } from "./command-palette.js";
import { renderTribunal } from "./tribunal-viz.js";
import { renderBlackboard } from "./blackboard-panel.js";
import { MODE_NAMES, MODE_DESCRIPTIONS, MODE_PRIVILEGE } from "../core/modes/index.js";

/** Workspace application state. */
export function initialWorkspaceState() {
  return {
    view: "workspace",
    activePanel: "main",
    sidebarCollapsed: false,
    inspectorCollapsed: false,
    inspectorTab: "execution",
    themeId: null,
    filterText: "",
    paletteQuery: "",
    paletteIndex: 0,
    paletteOpen: false,
    paletteCommands: [],
    sessions: [],
    currentSessionId: null,
    agents: [],
    currentAgentId: "coder",
    models: [],
    currentModelId: null,
    messages: [],
    streaming: false,
    streamBuffer: "",
    toolCalls: [],
    approvals: [],
    notifications: [],
    error: null,
    now: new Date().toLocaleTimeString(),
    securityOrchestrator: null,
    todoEngine: null,
    securityStatus: null,
    todoState: null,
    // Operating mode: Plan is the default (read-only, safest).
    // Tab cycles Plan → Build → Orchestrate → Auto → Plan.
    mode: "plan",
    modePrevious: null,
  };
}

/** Pad each line of a block to width `w`. */
function padBlock(lines, w) {
  return lines.map((l) => pad(truncate(l, w), w));
}

/** Render the full workspace frame as an array of lines (one per terminal row). */
export function renderWorkspaceLines(state, opts = {}) {
  const { cols, rows } = opts;
  const _theme = getActiveTheme();
  const layout = computeLayout({ cols, rows });

  // Refresh security status from real orchestrator
  if (state.securityOrchestrator) {
    state.securityStatus = state.securityOrchestrator.getSecurityStatusPanel();
  }

  // Refresh TODO state from real engine
  if (state.todoEngine) {
    const activeLists = state.todoEngine.getActiveTaskLists();
    if (activeLists.length > 0) {
      state.todoState = state.todoEngine.getSummary(activeLists[0].id);
    } else {
      state.todoState = null;
    }
  }

  const header = layout.get(REGIONS.HEADER);
  const sidebar = layout.get(REGIONS.SIDEBAR);
  const main = layout.get(REGIONS.MAIN);
  const inspector = layout.get(REGIONS.INSPECTOR);
  const prompt = layout.get(REGIONS.PROMPT);

  const headerLines = header ? renderHeader(state, header) : [];
  const sidebarLines = sidebar ? renderSidebar(state, sidebar) : [];
  const mainLines = main ? renderMain(state, main) : [];
  const inspectorLines = inspector ? renderInspector(state, inspector) : [];
  const promptLines = prompt ? renderPrompt(state, prompt) : [];

  // Body height = max of sidebar/main/inspector content
  const bodyH = Math.max(sidebarLines.length, mainLines.length, inspectorLines.length);

  // Pad all body regions to same height
  const paddedSidebar = padBlock(sidebarLines, sidebar ? sidebar.w : 0);
  const paddedMain = padBlock(mainLines, main ? main.w : 0);
  const paddedInspector = padBlock(inspectorLines, inspector ? inspector.w : 0);

  // Extend to bodyH
  while (paddedSidebar.length < bodyH) paddedSidebar.push(" ".repeat(sidebar ? sidebar.w : 0));
  while (paddedMain.length < bodyH) paddedMain.push(" ".repeat(main ? main.w : 0));
  while (paddedInspector.length < bodyH) paddedInspector.push(" ".repeat(inspector ? inspector.w : 0));

  const sidebarW = sidebar ? sidebar.w : 0;
  const mainW = main ? main.w : 0;
  const inspectorW = inspector ? inspector.w : 0;

  // Combine body rows
  const bodyRows = [];
  for (let r = 0; r < bodyH; r += 1) {
    let row = "";
    if (sidebarW > 0) row += paddedSidebar[r] || " ".repeat(sidebarW);
    if (mainW > 0) row += " " + (paddedMain[r] || " ".repeat(mainW));
    if (inspectorW > 0) row += " " + (paddedInspector[r] || " ".repeat(inspectorW));
    bodyRows.push(row);
  }

  const allLines = [...headerLines, "", ...bodyRows, "", ...promptLines];

  // ── Command palette overlay ─────────────────────────────────────────
  if (state.paletteOpen) {
    const cmds = filterCommands(state.paletteCommands || [], state.paletteQuery);
    const palette = renderPalette(cmds, state.paletteIndex, state.paletteQuery, {
      width: cols,
      height: rows,
    });
    const overlayLines = palette.split("\n");
    const startRow = Math.max(0, Math.floor((rows - overlayLines.length) / 2));
    const finalLines = [];
    for (let i = 0; i < rows; i += 1) {
      if (i >= startRow && i - startRow < overlayLines.length) {
        finalLines.push(overlayLines[i - startRow]);
      } else if (i < allLines.length) {
        finalLines.push(dim(allLines[i] || ""));
      } else {
        finalLines.push("");
      }
    }
    return finalLines.slice(0, rows);
  }

  // Pad/truncate to terminal rows
  while (allLines.length < rows) allLines.push("");
  return allLines.slice(0, rows);
}

/** Render as a single string (for console.log). */
export function renderWorkspace(state, opts = {}) {
  return renderWorkspaceLines(state, opts).join("\n");
}

/** Render header region. */
function renderHeader(state, _region) {
  const lines = [];
  const brand = paintToken("AgentFlow", "accent", "bold");
  const version = dim("v1.0.0");
  lines.push(`${brand}  ${version}`);

  const sessionChip = state.currentSessionId
    ? paintToken("session", "mutedText") + ": " + truncate(state.currentSessionId, 14)
    : paintToken("no session", "mutedText");
  const agentChip = paintToken("agent", "mutedText") + ": " + (state.currentAgentId || "—");
  const modelChip = paintToken("model", "mutedText") + ": " + (state.currentModelId || "—");

  // Mode indicator — active mode shown prominently with privilege color.
  const mode = state.mode || "plan";
  const modeName = MODE_NAMES[mode] || mode;
  const privilege = MODE_PRIVILEGE[mode] || 1;
  const modeColor = privilege >= 3 ? red : privilege >= 2 ? yellow : green;
  const modeChip = paintToken("MODE", "mutedText") + ": " + modeColor(modeName.toUpperCase()) + " " + dim(MODE_DESCRIPTIONS[mode] || "");

  const statusLine = gray(sessionChip.padEnd(22)) + gray(agentChip.padEnd(18)) + gray(modelChip);
  lines.push(statusLine);
  lines.push(modeChip);
  lines.push(dim("  Tab to cycle modes · Ctrl+P palette · Ctrl+T themes · / commands · Ctrl+Q quit · F1 help"));
  return lines;
}

/** Render sidebar region. */
function renderSidebar(state, _region) {
  const lines = [];
  lines.push(paintToken("NAVIGATION", "accent", "bold"));
  lines.push("");

  const items = [
    { label: "sessions", icon: "s", key: "sessions" },
    { label: "agents", icon: "a", key: "agents" },
    { label: "models", icon: "m", key: "models" },
    { label: "blackboard", icon: "b", key: "blackboard" },
    { label: "repo map", icon: "r", key: "map" },
    { label: "git", icon: "g", key: "git" },
    { label: "mcp", icon: "c", key: "mcp" },
    { label: "plugins", icon: "p", key: "plugins" },
    { label: "settings", icon: "c", key: "settings" },
  ];

  for (const item of items) {
    const isActive = item.key === state.activePanel;
    const marker = isActive ? "▸ " : "  ";
    const text = `${marker}${item.icon} ${item.label}`;
    if (isActive) {
      lines.push(paintToken(text, "accent", "bold"));
    } else {
      lines.push(text);
    }
  }

  lines.push("");
  lines.push(dim("themes · help · quit"));
  return lines;
}

/** Render main conversation region. */
function renderMain(state, region) {
  const { w } = region;
  const lines = [];
  lines.push(paintToken("CONVERSATION", "accent", "bold"));
  lines.push("");

  if (state.messages.length === 0) {
    lines.push(dim("No messages yet. Start a conversation or use /new."));
  } else {
    for (const msg of state.messages) {
      const roleColor = msg.role === "user" ? "userMessage" : msg.role === "assistant" ? "assistantMessage" : "systemMessage";
      const roleLabel = msg.role === "user" ? "you" : msg.role === "assistant" ? "agent" : "system";
      const prefix = paintToken(`${roleLabel}:`, roleColor, "bold");
      const body = truncate(msg.content || "", w - width(prefix) - 2);
      lines.push(`${prefix} ${body}`);
      lines.push("");
    }
  }

  if (state.streaming) {
    lines.push(dim("● streaming…") + " " + state.streamBuffer);
  }

  return lines;
}

/** Render inspector region. */
function renderInspector(state, region) {
  const { w } = region;
  const lines = [];
  lines.push(paintToken("INSPECTOR", "accent", "bold"));
  lines.push("");

  const tabs = ["execution", "model", "context", "files", "diff", "blackboard", "tribunal", "security", "todo"];
  for (let i = 0; i < tabs.length; i += 1) {
    const isActive = state.inspectorTab === tabs[i];
    const marker = isActive ? "▸ " : "  ";
    const text = `${marker}${tabs[i]}`;
    if (isActive) {
      lines.push(paintToken(text, "accent", "bold"));
    } else {
      lines.push(text);
    }
  }

  lines.push("");

  // Content based on active tab
  if (state.inspectorTab === "execution") {
    lines.push(paintToken("Execution", "accent", "bold"));
    if (state.streaming) {
      lines.push(dim("● streaming…") + " " + state.streamBuffer);
    } else {
      lines.push(dim("No active execution."));
    }
    lines.push("");
    lines.push(paintToken("Tool Calls", "accent", "bold"));
    if (state.toolCalls && state.toolCalls.length > 0) {
      for (const tc of state.toolCalls.slice(0, 5)) {
        const status = paintToken(tc.outcome || "pending", tc.outcome === "ok" ? "success" : "error");
        lines.push(`  ${tc.tool}: ${status}`);
      }
    } else {
      lines.push(dim("No tool calls yet."));
    }
  } else if (state.inspectorTab === "model") {
    lines.push(paintToken("Model", "accent", "bold"));
    lines.push(`  current: ${state.currentModelId || "—"}`);
    lines.push(`  provider: ${state.currentModelId ? state.currentModelId.split("/")[0] : "—"}`);
  } else if (state.inspectorTab === "blackboard") {
    lines.push(renderBlackboard(state.blackboard, { w }));
  } else if (state.inspectorTab === "tribunal") {
    lines.push(renderTribunal(state.tribunalResult, { w }));
  } else if (state.inspectorTab === "security") {
    lines.push(...renderSecurityPanel(state.securityStatus, { w }));
  } else if (state.inspectorTab === "todo") {
    lines.push(...renderTodoPanel(state.todoState, { w }));
  } else {
    lines.push(dim(`${state.inspectorTab} panel coming soon.`));
  }

  return lines;
}

/** Render security panel in the inspector. */
function renderSecurityPanel(securityStatus, _opts = {}) {
  const lines = [];

  if (!securityStatus) {
    lines.push(dim("Security panel not initialized."));
    return lines;
  }

  const { delivery, eligible, summary, scannerStatus, reasons } = securityStatus;

  lines.push(paintToken("Security Status", "accent", "bold"));
  lines.push("");

  const deliveryColor = eligible ? green : red;
  lines.push(`  delivery: ${deliveryColor(delivery.toUpperCase())}`);
  lines.push(`  eligible: ${eligible ? green("yes") : red("no")}`);
  lines.push("");

  lines.push(paintToken("Findings", "accent", "bold"));
  lines.push(`  critical: ${red(summary.critical)}  high: ${red(summary.high)}`);
  lines.push(`  medium: ${yellow(summary.medium)}  low: ${cyan(summary.low)}`);
  lines.push(`  confirmed: ${green(summary.confirmed)}`);
  lines.push(`  needing remediation: ${yellow(summary.needingRemediation)}`);
  lines.push("");

  lines.push(paintToken("Scanners", "accent", "bold"));
  const scannerNames = ["semgrep", "osv-scanner", "trivy", "codeql", "trufflehog", "zap", "garak"];
  for (const name of scannerNames) {
    const s = scannerStatus[name];
    if (!s) continue;
    const statusColor = s.status === "completed" ? green : s.status === "blocked" || s.status === "unavailable" ? red : dim;
    lines.push(`  ${name}: ${statusColor(s.status)}`);
  }
  lines.push("");

  if (reasons && reasons.length > 0) {
    lines.push(paintToken("Blocking Reasons", "error", "bold"));
    for (const reason of reasons) {
      lines.push(`  - ${reason}`);
    }
    lines.push("");
  }

  lines.push(dim("Evaluated: " + new Date(securityStatus.evaluatedAt || Date.now()).toLocaleTimeString()));

  return lines;
}

/** Render TODO panel. */
function renderTodoPanel(todoState, _opts = {}) {
  const lines = [];

  if (!todoState) {
    lines.push(dim("TODO panel not initialized."));
    return lines.join("\n");
  }

  lines.push(paintToken("TODO — Active Tasks", "accent", "bold"));
  lines.push(`  progress: ${todoState.progress}%  ${todoState.isComplete ? green("complete") : yellow("in progress")}`);
  lines.push(`  total: ${todoState.total}  completed: ${green(todoState.completed)}`);
  lines.push(`  blocked: ${red(todoState.blocked)}  pending: ${yellow(todoState.pending)}`);
  lines.push("");

  return lines.join("\n");
}

/** Render prompt composer region. */
function renderPrompt(state, region) {
  const { w } = region;
  const lines = [];
  const input = drawInput("cmd", state.filterText || "", state.filterText ? state.filterText.length : 0, { width: w - 4 });
  lines.push(paintToken(">", "accent", "bold") + " " + input);
  lines.push(dim("  /help · /new · /sessions · /models · /agents · /themes · /settings · /quit"));
  return lines;
}

export default { renderWorkspace, renderWorkspaceLines, initialWorkspaceState };
