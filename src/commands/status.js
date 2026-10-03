// `aflow status` — one-screen health summary.
//
// Deliberately cheap: no probing by default, because status should be safe to
// run on every prompt or in a status bar. Pass --probe for live checks.

import { defineCommand } from "../cli/registry.js";
import { ping, getVersion, probeModel, listModels } from "../core/gateway.js";
import { bold, dim, table, heading, statusColor, green, red, yellow } from "../cli/ui.js";

async function runStatus({ config, out, flags }) {
  const p = await ping(config);

  let version = null;
  let catalogue = null;
  let probes = [];

  if (p.ok) {
    try {
      version = await getVersion(config);
    } catch {
      /* informational */
    }
    try {
      catalogue = (await listModels(config)).length;
    } catch {
      /* optional */
    }
    if (flags.probe && config.defaultModel) {
      probes = [await probeModel(config, config.defaultModel)];
    }
  }

  const payload = {
    baseUrl: config.baseUrl,
    reachable: p.ok,
    latencyMs: p.elapsedMs,
    version: version?.currentVersion ?? null,
    latestVersion: version?.latestVersion ?? null,
    hasUpdate: version?.hasUpdate ?? false,
    catalogueCount: catalogue,
    defaultModel: config.defaultModel,
    probes,
  };

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow status")));
    if (!r.reachable) {
      lines.push(red(`gateway unreachable at ${r.baseUrl}`));
      lines.push(dim("start it with: node custom-server.js --port 20127"));
      lines.push(dim(`or point aflow elsewhere: aflow status --base-url http://host:port`));
      return lines.join("\n");
    }

    const rows = [
      { k: "gateway", v: `${r.baseUrl} ${green("up")}` },
      { k: "latency", v: `${r.latencyMs}ms` },
    ];
    if (r.version) rows.push({ k: "version", v: `${r.version}${r.hasUpdate ? yellow(` (update: ${r.latestVersion})`) : ""}` });
    if (r.catalogueCount) rows.push({ k: "models", v: `${r.catalogueCount} advertised` });
    if (r.defaultModel) rows.push({ k: "default", v: r.defaultModel });

    lines.push(
      table(rows, [
        { key: "k", label: "" },
        { key: "v", label: "" },
      ])
    );

    if (r.probes.length) {
      lines.push("");
      for (const pr of r.probes) {
        lines.push(`  ${statusColor(pr.status)}  ${pr.model} ${dim(`${pr.elapsedMs}ms`)}`);
      }
    } else {
      lines.push("");
      lines.push(dim("run `aflow doctor` for reachability, or `aflow status --probe`"));
    }
    return lines.join("\n");
  });

  return p.ok ? 0 : 1;
}

export const statusCommand = defineCommand("status", {
  summary: "show gateway health and version",
  usage: `aflow status [--probe]

Cheap health check against the configured gateway. Safe to run frequently.

  --probe   also send one request to the configured default model`,
  run: runStatus,
});

export default statusCommand;