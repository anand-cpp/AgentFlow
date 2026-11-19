// `aflow connectors` — terminal UI for browsing and connecting to 100+ providers.

import { defineCommand } from "../cli/registry.js";
import { bold, dim, green, red, yellow } from "../cli/ui.js";
import {
  resetState,
  setFilter,
  getFilteredProviders,
  renderConnectorList,
  renderConnectorDetail,
  renderConnectScreen,
} from "../tui/connector-browser.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { heading } from "../cli/ui.js";

let currentView = "list";
let currentProviderId = null;

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function hideCursor() {
  process.stdout.write("\x1b[?25l");
}

function showCursor() {
  process.stdout.write("\x1b[?25h");
}

async function readKey() {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(chunk.toString());
    });
  });
}

export async function run({ _args, _flags, _config, out }) {
  const ttY = process.stdout.isTTY && process.stdin.isTTY;
  if (!ttY) {
    // Non-TTY: just list providers as JSON or text
    const all = Object.entries(PROVIDERS);
    out.init({ providers: all.length }, () => {
      const lines = all.map(([id, prov]) => `  ${id.padEnd(24)} ${prov.display?.name || id} [${prov.category || "apikey"}]`);
      return `${bold("Providers")} (${all.length})\n\n${lines.join("\n")}\n`;
    });
    return 0;
  }

  hideCursor();
  resetState();
  currentView = "list";
  currentProviderId = null;
  let selectedIndex = 0;
  let scrollOffset = 0;

  try {
    while (true) {
      clearScreen();

      if (currentView === "list") {
        const rows = getFilteredProviders();
        const termWidth = process.stdout.columns || 80;
        const termHeight = process.stdout.rows || 40;
        console.log(renderConnectorList(rows, termWidth, termHeight));
      } else if (currentView === "detail") {
        const prov = PROVIDERS[currentProviderId];
        if (prov) {
          console.log(renderConnectorDetail(currentProviderId, prov));
        } else {
          currentView = "list";
          continue;
        }
      } else if (currentView === "connect") {
        const prov = PROVIDERS[currentProviderId];
        if (prov) {
          console.log(renderConnectScreen(currentProviderId, prov));
        } else {
          currentView = "list";
          continue;
        }
      }

      const key = await readKey();

      // Handle filter input mode
      if (currentView === "list" && key === "/") {
        process.stdout.write("\x1b[2K\rFilter: ");
        process.stdin.setRawMode(false);
        const input = await new Promise((res) => {
          process.stdin.once("data", (d) => res(d.toString().trim()));
        });
        process.stdin.setRawMode(true);
        setFilter(input);
        continue;
      }

      if (currentView === "list") {
        const rows = getFilteredProviders();
        if (key === "\x1b[A") { // Up
          selectedIndex = Math.max(0, selectedIndex - 1);
          if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
        } else if (key === "\x1b[B") { // Down
          selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
          const listHeight = (process.stdout.rows || 40) - 8;
          if (selectedIndex >= scrollOffset + listHeight) scrollOffset = selectedIndex - listHeight + 1;
        } else if (key === "\r" || key === "\n") {
          const [id] = rows[selectedIndex];
          currentProviderId = id;
          currentView = "detail";
        } else if (key === "c") {
          const [id] = rows[selectedIndex];
          currentProviderId = id;
          currentView = "connect";
        } else if (key === "d") {
          const [id] = rows[selectedIndex];
          currentProviderId = id;
          currentView = "detail";
        } else if (key === "q" || key === "\x03") { // q or Ctrl+C
          break;
        }
      } else if (currentView === "detail" || currentView === "connect") {
        if (key === "b") {
          currentView = "list";
        } else if (key === "q" || key === "\x03") {
          break;
        } else if (currentView === "connect" && key === "c") {
          const prov = PROVIDERS[currentProviderId];
          clearScreen();
          console.log(heading(` Connecting: ${currentProviderId}`));
          console.log("");
          console.log(`  Provider: ${bold(prov.display?.name || currentProviderId)}`);
          console.log(`  Endpoint: ${dim(prov.baseUrl || "N/A")}`);
          console.log("");
          // Attempt a lightweight reachability check
          try {
            const res = await fetch(`${prov.baseUrl.replace(/\/+$/, "")}/models`, {
              method: "GET",
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              console.log(green("  ✓ Connection successful"));
            } else {
              console.log(yellow(`  ⚠ Responded with status ${res.status}`));
            }
          } catch (err) {
            console.log(red(`  ✗ Connection failed: ${err.message}`));
          }
          console.log("");
          console.log(dim(" Press any key to continue..."));
          await readKey();
          currentView = "list";
        }
      }
    }
  } finally {
    clearScreen();
    showCursor();
  }

  return 0;
}

defineCommand("connectors", {
  summary: "browse and connect to 100+ AI model providers",
  valueFlags: ["filter", "provider", "connect"],
  run,
});

export default { run };
