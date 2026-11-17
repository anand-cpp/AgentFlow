// Connector Browser — terminal UI for browsing 100+ AI model providers.
// Renders a searchable, filterable list of providers with connection status.

import { setColor, bold, dim, green, red, yellow, cyan, gray, paint, width, truncate, pad, heading } from "../cli/ui.js";
import { drawBox, drawSelectList, drawStatusLine } from "../tui/components.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";

let selectedIndex = 0;
let scrollOffset = 0;
let filterText = "";
let viewMode = "list"; // "list" | "detail" | "connect"

export function resetState() {
  selectedIndex = 0;
  scrollOffset = 0;
  filterText = "";
  viewMode = "list";
}

export function setFilter(text) {
  filterText = text.toLowerCase();
  selectedIndex = 0;
  scrollOffset = 0;
}

export function getFilteredProviders() {
  const all = Object.entries(PROVIDERS);
  if (!filterText) return all;
  return all.filter(([id, prov]) => {
    const name = prov.display?.name || id;
    return id.toLowerCase().includes(filterText) || name.toLowerCase().includes(filterText);
  });
}

export function renderConnectorList(rows, terminalWidth, terminalHeight) {
  const lines = [];
  lines.push(heading(" AI Connector Browser"));
  lines.push(dim(` ${Object.keys(PROVIDERS).length} providers · ${getFilteredProviders().length} matching`));
  lines.push("");

  const listHeight = terminalHeight - 8;
  const visible = getFilteredProviders().slice(scrollOffset, scrollOffset + listHeight);

  for (let i = 0; i < visible.length; i++) {
    const absIdx = scrollOffset + i;
    const [id, prov] = visible[i];
    const isSelected = absIdx === selectedIndex;
    const models = PROVIDER_MODELS[id] || [];
    const modelCount = models.length;
    const category = prov.category || "apikey";
    const catColor = category === "free" ? green : category === "oauth" ? yellow : cyan;

    let line = `  ${isSelected ? "▶" : " "} `;
    line += isSelected ? cyan(bold(id.padEnd(22))) : gray(id.padEnd(22));
    line += ` ${catColor(bold((prov.display?.name || id).padEnd(28)))}`;
    line += ` ${gray(`[${category}]`)}`;
    line += ` ${dim(`${modelCount} models`)}`;

    if (isSelected) {
      lines.push(paint("bg-blue", line));
    } else {
      lines.push(line);
    }
  }

  // Scroll indicator
  const total = getFilteredProviders().length;
  if (total > listHeight) {
    const pct = Math.round((scrollOffset / Math.max(total - listHeight, 1)) * 100);
    lines.push("");
    lines.push(dim(` Scroll: ${scrollOffset}/${total - listHeight} (${pct}%)`));
  }

  lines.push("");
  lines.push(dim(" Keys: ↑↓ navigate · / filter · c connect · d detail · q quit"));

  return lines.join("\n");
}

export function renderConnectorDetail(id, prov) {
  const models = PROVIDER_MODELS[id] || [];
  const lines = [];
  lines.push(heading(` Connector: ${id}`));
  lines.push("");
  lines.push(`  Name:    ${bold(prov.display?.name || id)}`);
  lines.push(`  Category: ${prov.category || "apikey"}`);
  lines.push(`  Auth:    ${prov.authType || "apikey"}`);
  lines.push(`  Base URL: ${dim(prov.baseUrl || "N/A")}`);
  lines.push(`  Format:  ${prov.format || "openai"}`);
  lines.push(`  Models:  ${models.length}`);
  lines.push("");

  if (models.length > 0) {
    lines.push(dim(" Available models:"));
    for (const m of models.slice(0, 15)) {
      lines.push(`    • ${m.id}${m.name ? ` — ${m.name}` : ""}`);
    }
    if (models.length > 15) {
      lines.push(`    ... and ${models.length - 15} more`);
    }
  }

  lines.push("");
  lines.push(dim(" Keys: c connect · b back · q quit"));

  return lines.join("\n");
}

export function renderConnectScreen(id, prov) {
  const lines = [];
  lines.push(heading(` Connect: ${id}`));
  lines.push("");
  lines.push(`  Provider: ${bold(prov.display?.name || id)}`);
  lines.push(`  Endpoint: ${dim(prov.baseUrl || "N/A")}`);
  lines.push("");
  lines.push(yellow("  This will attempt a connection test to the provider."));
  lines.push("");
  lines.push(dim(" Keys: c confirm · b back · q quit"));

  return lines.join("\n");
}

export { selectedIndex, scrollOffset, filterText, viewMode };
