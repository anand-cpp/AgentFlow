// `aflow models` — the catalogue, annotated with live reachability.
//
// Upstream's dashboard shows 790 models with no indication of whether any of
// them work. This command exists to make that distinction impossible to miss:
// the default view groups models by provider and, with --probe, tests them.

import { defineCommand } from "../cli/registry.js";
import { listModels, probeModel } from "../core/gateway.js";
import { classifyModelCost, countCostClasses, orderByCost } from "../core/model-cost.js";
import { PROVIDERS } from "../core/gateway-server.js";
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

/**
 * @param {{ config?: object, out?: object, flags?: object, deps?: { health?: { getProviderStatus(provider: string): object | null } | null } }} opts
 */
async function runModels({ config, out, flags, deps = {} } = {}) {
  const all = await listModels(config);
  const filter = args0(flags);
  const selected = filter ? all.filter((m) => m.id.includes(filter)) : all;

  const shouldProbe = Boolean(flags.probe);
  const shouldDetail = Boolean(flags.detail);
  const limit = Number(flags.limit) || 20;
  const probes = [];
  const health = deps.health ?? null;

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

  // The same policy the router applies to anonymous candidates. Keeping it here
  // means `--detail` explains the real order instead of inventing a second one.
  // Explicit choices are labelled before this list is consulted.
  const ranked = orderByCost(
    selected.map((m) => m.id),
    {
      hints: config.modelHints || {},
      catalogue: all.map((m) => m.id),
      preferFree: config.preferFree !== false,
      allowPaid: config.allowPaidFallback === true,
    }
  );
  const rankById = new Map(ranked.map((id, i) => [id, i + 1]));

  const describe = (m) => {
    const provider = m.provider || null;
    const cost = classifyModelCost(m.id, { declared: config.modelHints?.[m.id] ?? null });
    const declared = config.modelHints?.[m.id] ?? null;
    const rate = provider ? PROVIDERS[provider]?.ratePerMin ?? null : null;
    const status = provider && health?.getProviderStatus ? health.getProviderStatus(provider) : null;
    const cooling = status?.cooldownRemainingMs > 0;
    const rank = rankById.get(m.id) ?? null;
    const selection =
      config.defaultModel === m.id
        ? "explicit"
        : rank !== null
          ? "ranked"
          : cost.class === "paid" && config.allowPaidFallback !== true
            ? "paid-disabled"
            : "excluded";
    return {
      id: m.id,
      provider,
      costClass: cost.class,
      costSource: cost.source,
      selection,
      rank,
      requestLimit: Number.isFinite(rate) && rate > 0
        ? { perMinute: rate, source: "provider-registry:ratePerMin", kind: "request-rate" }
        : { perMinute: null, source: null, kind: "unknown" },
      // Static metadata vs dynamic health: `toolCalling` comes from a user hint,
      // never from a model name. Dynamic state is null when no ProviderHealth
      // exists in this process -- that is unknown, not "eligible".
      toolCalling: typeof declared?.toolCalling === "boolean" ? declared.toolCalling : "unknown",
      health: status
        ? {
            circuitState: status.circuitState,
            eligible: !cooling && status.circuitState !== "open",
            cooldownUntil: status.cooldownUntil ?? null,
            cooldownRemainingMs: status.cooldownRemainingMs ?? 0,
            cooldownReason: status.cooldownReason ?? null,
            cooldownSource: status.cooldownSource ?? null,
          }
        : null,
      probe: probeById.get(m.id)?.status ?? null,
    };
  };

  const described = selected.map(describe);
  const costCounts = countCostClasses(Object.fromEntries(described.map((m) => [m.id, m.costClass])));

  const payload = {
    total: selected.length,
    advertisedTotal: all.length,
    providerCount: groups.length,
    costCounts,
    modelsTotal: described.length,
    models: described.slice(0, 500),
    groups: groups.map(([provider, models]) => ({
      provider,
      count: models.length,
      models: models.slice(0, limit).map((m) => {
        const d = describe(m);
        return {
          id: m.id,
          probe: d.probe,
          costClass: d.costClass,
          selection: d.selection,
          rank: d.rank,
          requestLimit: d.requestLimit,
          toolCalling: d.toolCalling,
          health: d.health,
        };
      }),
    })),
    probes,
  };

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow models")));
    lines.push(
      dim(
        `cost classes: ${r.costCounts.free} free · ${r.costCounts["free-tier"]} free-tier · ` +
          `${r.costCounts.unknown} unknown · ${r.costCounts.paid} paid`
      )
    );
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

    if (shouldDetail) {
      lines.push(dim("Static metadata and local eligibility (health is process-local; '-' means unknown):"));
      lines.push(
        table(
          r.models.slice(0, 60).map((m) => ({
            model: m.id,
            cost: m.costClass,
            selection: m.selection === "ranked" ? `#${m.rank}` : m.selection,
            limit: m.requestLimit.perMinute == null ? dim("unknown") : `${m.requestLimit.perMinute}/min`,
            tools: m.toolCalling === true ? "yes" : m.toolCalling === false ? "no" : dim("unknown"),
            eligibility: m.health
              ? m.health.eligible
                ? "eligible"
                : `cooling ${Math.ceil((m.health.cooldownRemainingMs || 0) / 1000)}s`
              : dim("-"),
          })),
          [
            { key: "model", label: "MODEL", max: 42 },
            { key: "cost", label: "COST" },
            { key: "selection", label: "SELECTION" },
            { key: "limit", label: "LIMIT" },
            { key: "tools", label: "TOOLS" },
            { key: "eligibility", label: "ELIGIBILITY" },
          ]
        )
      );
      if (r.modelsTotal > 60) lines.push(dim(`  … and ${r.modelsTotal - 60} more (use a filter)`));
      if (r.models.length < r.modelsTotal) {
        lines.push(dim(`  JSON lists the first ${r.models.length} of ${r.modelsTotal}; filter to see the rest`));
      }
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
  usage: `aflow models [filter] [--probe] [--detail] [--limit N]

Lists the gateway's model catalogue grouped by provider.

  filter        substring match on model id
  --probe       send a minimal request to sampled models per provider and
                report which actually return content
  --detail      show cost class, selection mode, known request-rate limit,
                tool-calling support, and local cooldown/eligibility
  --limit N     models shown per provider (default 20)

A listed model is not necessarily a working model: providers without active
credentials fail at request time. Use --probe to tell them apart. Cost class is
static evidence; cooldown is dynamic local health and is unknown when no health
state exists in this process. A request-rate limit is not a daily quota or a
claim about remaining credits.`,
  run: ({ config, out, flags, args, deps }) =>
    runModels({ config, out, flags: { ...flags, __filter: args[0] }, deps: deps ?? {} }),
});

export default modelsCommand;
