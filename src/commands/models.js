// `aflow models` — the catalogue, annotated with live reachability.
//
// Upstream's dashboard shows 790 models with no indication of whether any of
// them work. This command exists to make that distinction impossible to miss:
// the default view groups models by provider and, with --probe, tests them.

import { defineCommand } from "../cli/registry.js";
import { listModels, probeModel } from "../core/gateway.js";
import { bold, dim, table, heading, statusColor, cyan, yellow } from "../cli/ui.js";

function groupByProvider(models) {
  const groups = new Map();
  for (const m of models) {
    const key = m.provider || "(unprefixed)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

async function runModels({ config, out, flags }) {
  const all = await listModels(config);
  const filter = args0(flags);
  const selected = filter ? all.filter((m) => m.id.includes(filter)) : all;

  const shouldProbe = Boolean(flags.probe);
  const limit = Number(flags.limit) || 20;
  const probes = [];

  if (shouldProbe) {
    // Probe a bounded sample. Probing everything would take minutes; sampling
    // per provider gives a fair signal at a fraction of the cost.
    const perProvider = new Map();
    const targets = [];
    for (const m of selected) {
      const key = m.provider || "(unprefixed)";
      const n = perProvider.get(key) || 0;
      if (n < 2) {
        perProvider.set(key, n + 1);
        targets.push(m);
      }
    }
    out.status(dim(`probing ${targets.length} model(s) across ${perProvider.size} provider(s)…`));
    for (const m of targets) {
      probes.push(await probeModel(config, m.id));
    }
  }

  const probeById = new Map(probes.map((p) => [p.model, p]));
  const groups = groupByProvider(selected);

  const payload = {
    total: selected.length,
    advertisedTotal: all.length,
    providerCount: groups.length,
    groups: groups.map(([provider, models]) => ({
      provider,
      count: models.length,
      models: models.slice(0, limit).map((m) => ({
        id: m.id,
        probe: probeById.get(m.id)?.status ?? null,
      })),
    })),
    probes,
  };

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow models")));
    if (r.probes.length) {
      const ok = r.probes.filter((p) => p.status === "ok").length;
      lines.push(
        `${r.advertisedTotal} advertised · ${r.providerCount} providers · ` +
          (ok === 0
            ? yellow("0 probed models returned content")
            : `${ok}/${r.probes.length} probed returned content`)
      );
      lines.push("");
      lines.push(
        table(
          r.probes.map((p) => ({
            model: p.model,
            status: statusColor(p.status),
            ms: p.elapsedMs,
            note: p.status === "ok" ? `sample: ${p.sample}` : (p.detail ?? ""),
          })),
          [
            { key: "model", label: "MODEL", max: 44 },
            { key: "status", label: "STATUS" },
            { key: "ms", label: "MS", align: "right" },
            { key: "note", label: "NOTE", max: 46 },
          ]
        )
      );
      lines.push("");
    }

    lines.push(dim("Providers by model count (use --probe to test reachability):"));
    for (const g of r.groups.slice(0, 25)) {
      lines.push(`  ${cyan(g.provider.padEnd(24))} ${String(g.count).padStart(4)}`);
    }
    if (r.groups.length > 25) lines.push(dim(`  … and ${r.groups.length - 25} more`));
    return lines.join("\n");
  });

  return 0;
}

// `aflow models <filter>` — positional filter, kept out of the flag parser.
function args0(flags) {
  return flags.__filter || null;
}

export const modelsCommand = defineCommand("models", {
  valueFlags: ["limit"],
  summary: "list models by provider, optionally probing reachability",
  usage: `aflow models [filter] [--probe] [--limit N]

Lists the gateway's model catalogue grouped by provider.

  filter        substring match on model id
  --probe       send a minimal request to sampled models per provider and
                report which actually return content
  --limit N     models shown per provider (default 20)

A listed model is not necessarily a working model: providers without active
credentials fail at request time. Use --probe to tell them apart.`,
  run: ({ config, out, flags, args }) =>
    runModels({ config, out, flags: { ...flags, __filter: args[0] } }),
});

export default modelsCommand;