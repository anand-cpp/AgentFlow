// `aflow dashboard` — launch the TUI.

import { defineCommand } from "../cli/registry.js";
import { ping, getVersion, listModels, probeModel } from "../core/gateway.js";
import { runDashboard } from "../tui/dashboard.js";

const CANDIDATES = [
  "oc/muse-spark-1.3-contributor-free",
  "ocz/deepseek-v4-flash-free",
];

async function collectState(config, { doProbe }) {
  const p = await ping(config);
  if (!p.ok) {
    return { reachable: false, error: p.error, baseUrl: config.baseUrl, latencyMs: p.elapsedMs, probes: [] };
  }

  let version = null;
  let catalogueCount = null;
  try {
    version = await getVersion(config);
  } catch {
    /* informational */
  }
  try {
    catalogueCount = (await listModels(config)).length;
  } catch {
    /* optional */
  }

  let probes = [];
  if (doProbe) {
    for (const m of config.defaultModel ? [config.defaultModel] : CANDIDATES) {
      probes.push(await probeModel(config, m));
    }
  }

  return {
    reachable: true,
    latencyMs: p.elapsedMs,
    version: version?.currentVersion ?? null,
    catalogueCount,
    reachableProbeCount: doProbe ? probes.filter((x) => x.status === "ok").length : null,
    probes,
    baseUrl: config.baseUrl,
    now: new Date().toISOString().slice(11, 19),
  };
}

async function runDash({ config, out, flags }) {
  // Seed with a probe so the first frame is informative rather than empty.
  const initial = await collectState(config, { doProbe: true });

  const refresh = () => collectState(config, { doProbe: true });
  const probe = () => collectState(config, { doProbe: true });

  const intervalMs = Number(flags.interval) || 8000;

  if (!process.stdout.isTTY) {
    // Non-interactive: render exactly one frame as JSON or text so the command
    // is still useful in a pipe or a health check.
    await out.init(initial, (s) =>
      s.reachable
        ? `${s.version ? `version ${s.version}\n` : ""}gateway ${s.baseUrl} up (${s.latencyMs}ms)\n` +
            `${s.catalogueCount ?? "?"} models advertised, ${s.reachableProbeCount ?? "?"}/${(s.probes || []).length} probed reachable`
        : `gateway unreachable: ${s.error}`
    );
    return s0(initial);
  }

  return runDashboard({ refresh, probe, intervalMs });
}

function s0(initial) {
  return initial.reachable ? 0 : 1;
}

export const dashboardCommand = defineCommand("dashboard", {
  valueFlags: ["interval"],
  summary: "open the interactive terminal dashboard",
  usage: `aflow dashboard [--interval MS]

Interactive dashboard inside the terminal: gateway health, version, advertised
model count, and live provider reachability.

Keys:
  r   refresh now
  p   re-probe providers
  q   quit

Without a TTY it prints a single snapshot instead, so it stays usable in pipes.`,
  run: runDash,
});

export default dashboardCommand;