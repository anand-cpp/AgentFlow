// Interactive TUI dashboard.
//
// Design note (DeepSeek's `headless` profile and OpenCode's `tui` package both
// argue for this shape): the terminal IS the dashboard. Upstream ships a
// Next.js dashboard because it was a web product; a terminal-first client
// should present the same information without a browser.
//
// Zero runtime dependencies. Uses raw ANSI and readline rather than a TUI
// framework, so `aflow` stays installable anywhere Node runs. Rendering is
// redraw-on-interval with full-screen clear, which is sufficient for a
// read-mostly status view and avoids the input-parsing complexity of a full
// screen app.
//
// Non-interactive terminals are detected: the dashboard refuses to run without
// a TTY rather than emitting escape codes into a pipe.

import readline from "node:readline";
import { setColor, bold, dim, table, statusColor, truncate, green, red, yellow, cyan } from "../cli/ui.js";

const isTTY = process.stdout.isTTY && process.stdin.isTTY;

function clearScreen() {
  // Home cursor + clear to end of screen. Works on Windows Terminal, modern
  // VT100 emulators, and most CI log viewers.
  process.stdout.write("\u001b[H\u001b[2J\u001b[3J");
}

function enterAltScreen() {
  process.stdout.write("\u001b[?1049h");
}

function exitAltScreen() {
  process.stdout.write("\u001b[?1049l");
}

/**
 * Render one dashboard frame.
 * `state` carries whatever the refresh function produced, so rendering stays
 * a pure function of state and is trivially testable.
 */
export function renderFrame(state, termWidth = 100) {
  const L = [];
  const t = state.now || new Date().toISOString().slice(11, 19);
  const bar = "─".repeat(Math.min(termWidth, 100));

  L.push(bold("AgentFlow") + dim("  terminal dashboard"));
  L.push(bar);

  // Top strip: the four numbers an operator checks first.
  const stats = [
    { label: "gateway", value: state.reachable ? green("up") : red("down"), detail: state.latencyMs ? `${state.latencyMs}ms` : "" },
    { label: "version", value: state.version || dim("—"), detail: "" },
    { label: "advertised", value: String(state.catalogueCount ?? "—"), detail: dim("models") },
    { label: "reachable", value: state.reachableProbeCount !== null ? String(state.reachableProbeCount) : dim("—"), detail: dim("probed") },
  ];
  const cols = Math.floor((termWidth - 3) / 4);
  let strip = "";
  for (const s of stats) {
    const body = `${bold(s.label.padEnd(11))}${s.value}`;
    strip += body + (s.detail ? ` ${dim(s.detail)}` : "");
    strip += " ".repeat(Math.max(1, cols - widthOf(body) - (s.detail ? s.detail.length : 0)));
  }
  L.push(strip);
  L.push("");

  if (!state.reachable) {
    L.push(red("Gateway unreachable"));
    L.push(dim(`  ${state.error || ""}`));
    L.push(dim(`  start: node custom-server.js --port ${new URL(state.baseUrl || "http://x:20127").port || 20127}`));
  } else if (state.probes?.length) {
    L.push(bold("Provider reachability"));
    L.push(
      table(
        state.probes.map((p) => ({
          model: p.model,
          status: statusColor(p.status),
          ms: p.elapsedMs,
          note: p.status === "ok" ? truncate(p.sample || "", 30) : truncate(p.detail || "", 34),
        })),
        [
          { key: "model", label: "MODEL", max: 40 },
          { key: "status", label: "STATUS" },
          { key: "ms", label: "MS", align: "right" },
          { key: "note", label: "NOTE", max: 36 },
        ]
      )
    );
  } else {
    L.push(dim("No probe data yet…"));
  }

  if (state.recent?.length) {
    L.push("");
    L.push(bold("Recent requests"));
    for (const r of state.recent.slice(-8)) {
      const dur = r.elapsedMs ? dim(`${r.elapsedMs}ms`) : dim("—");
      L.push(`  ${dim(r.at || "")}  ${truncate(r.model || "", 36).padEnd(36)}  ${dur}`);
    }
  }

  L.push("");
  L.push(bar);
  L.push(dim(`  ${t}   r refresh · p probe · q quit`));
  return L.join("\n");
}

function widthOf(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, "").length;
}

/**
 * Run the dashboard until the user quits.
 * `refresh` returns the state object consumed by renderFrame.
 */
export async function runDashboard({ refresh, intervalMs = 5000, probe = null }) {
  if (!isTTY) {
    const err = new Error("aflow dashboard requires an interactive terminal (stdout is not a TTY)");
    err.code = "not_tty";
    throw err;
  }

  setColor(true);
  enterAltScreen();
  const rl = readline.createInterface({ input: process.stdin, terminal: true });
  rl.resume();

  let state = { baseUrl: "", reachable: false };
  let stopped = false;

  const doRefresh = async () => {
    try {
      state = await refresh();
    } catch (err) {
      state = { reachable: false, error: err.message, baseUrl: state.baseUrl, probes: [] };
    }
    if (!stopped) {
      clearScreen();
      process.stdout.write(`${renderFrame(state)}\n`);
    }
  };

  await doRefresh();

  const timer = setInterval(doRefresh, intervalMs);
  if (timer.unref) timer.unref();

  await new Promise((resolve) => {
    rl.on("line", async (line) => {
      const key = line.trim().toLowerCase();
      if (key === "q" || key === "quit" || key === "exit" || line === "\u0003") {
        stopped = true;
        clearInterval(timer);
        rl.close();
        resolve();
        return;
      }
      if (key === "p" || key === "probe") {
        if (probe) {
          if (!stopped) process.stdout.write(dim("\nprobing…\n"));
          state = await probe();
          clearScreen();
          process.stdout.write(`${renderFrame(state)}\n`);
        }
        return;
      }
      // any other key: refresh
      await doRefresh();
    });
    rl.on("SIGINT", () => {
      stopped = true;
      clearInterval(timer);
      rl.close();
      resolve();
    });
  });

  exitAltScreen();
  process.stdout.write("bye\n");
  return 0;
}

export default { runDashboard, renderFrame };