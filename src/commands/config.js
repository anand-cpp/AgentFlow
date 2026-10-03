// `aflow config` — show effective configuration and where each value came from.
//
// A config system nobody can inspect is a config system nobody trusts. This
// command prints the resolved value AND the layer that supplied it.

import { defineCommand } from "../cli/registry.js";
import { resolveConfig, projectConfigPaths, globalConfigPath, DEFAULTS } from "../config/index.js";
import { redactDeep } from "../core/redact.js";
import { bold, dim, table, heading, cyan } from "../cli/ui.js";

async function runConfig({ config, out, flags }) {
  const sources = [];
  const gp = globalConfigPath();
  const fs = await import("node:fs");
  if (fs.existsSync(gp)) sources.push({ layer: "global", file: gp });
  for (const p of projectConfigPaths()) sources.push({ layer: "project", file: p });
  if (Object.keys(process.env).some((k) => k.startsWith("AGENTFLOW_"))) {
    sources.push({ layer: "environment", file: "AGENTFLOW_*" });
  }

  const keys = Object.keys(DEFAULTS);
  const entries = keys.map((k) => ({
    key: k,
    value: formatValue(config[k]),
    isDefault: JSON.stringify(config[k]) === JSON.stringify(DEFAULTS[k]),
  }));

  // Never echo credentials, in either output mode. `aflow config` is a
  // diagnostic people paste into issues, so an unmasked API key here would
  // leak by default.
  const safeConfig = redactDeep(config);

  const payload = {
    effective: safeConfig,
    default: DEFAULTS,
    sources,
    precedence: ["defaults", "global file", "project file", "AGENTFLOW_* env", "flags"],
  };

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow config")));
    lines.push(
      table(
        r.effective &&
          Object.keys(r.effective).map((k) => ({
            key: k,
            value: formatValue(r.effective[k]),
            origin: Object.is(r.effective[k], r.default[k]) ? dim("default") : cyan("set"),
          })),
        [
          { key: "key", label: "KEY" },
          { key: "value", label: "VALUE", max: 44 },
          { key: "origin", label: "ORIGIN" },
        ]
      )
    );
    lines.push("");
    lines.push(bold("Layers read (low → high)"));
    if (!r.sources.length) lines.push(dim("  defaults only"));
    for (const s of r.sources) lines.push(`  ${dim(s.layer.padEnd(12))} ${s.file}`);
    lines.push("");
    lines.push(dim(`precedence: ${r.precedence.join("  <  ")}`));
    return lines.join("\n");
  });
  return 0;
}

function formatValue(v) {
  if (v === null || v === undefined) return "(unset)";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export const configCommand = defineCommand("config", {
  summary: "show effective configuration and where each value came from",
  usage: `aflow config

Prints the resolved configuration after applying every layer, plus which files
and environment variables contributed.

Precedence, low to high:
  defaults  <  global file  <  project file  <  AGENTFLOW_* env  <  flags`,
  run: runConfig,
});

export default configCommand;