// `aflow init` — write a starter project config.

import { defineCommand } from "../cli/registry.js";
import { CONFIG_BASENAME } from "../config/index.js";
import { bold, dim, heading, green } from "../cli/ui.js";

const TEMPLATE = {
  baseUrl: "http://localhost:20127",
  defaultModel: null,
  theme: "auto",
  probeTimeoutMs: 15000,
};

async function runInit({ config, out, flags, args }) {
  const target = args[0] || CONFIG_BASENAME;
  const dryRun = Boolean(flags["dry-run"]);

  const payload = { file: target, written: false, dryRun, config: TEMPLATE };

  const fs = await import("node:fs");
  const exists = fs.existsSync(target);

  if (exists && !flags.force) {
    await out.init({ ...payload, error: `${target} already exists` }, () =>
      `${red("refusing to overwrite")} ${target}\n${dim("pass --force to replace it")}`
    );
    return 1;
  }

  if (!dryRun) {
    fs.writeFileSync(target, `${JSON.stringify(TEMPLATE, null, 2)}\n`);
  }

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow init")));
    lines.push(`${r.dryRun ? dim("would write") : green("wrote")} ${bold(r.file)}`);
    lines.push("");
    lines.push(JSON.stringify(r.config, null, 2));
    if (!r.dryRun) {
      lines.push("");
      lines.push(dim("next: aflow doctor"));
    }
    return lines.join("\n");
  });
  return 0;
}

import { red } from "../cli/ui.js";

export const initCommand = defineCommand("init", {
  summary: "create a starter project config",
  usage: `aflow init [file] [--force] [--dry-run]

Writes a starter .agentflow.json in the current directory.

  --force      overwrite an existing file
  --dry-run    print what would be written without touching disk`,
  run: runInit,
});

export default initCommand;