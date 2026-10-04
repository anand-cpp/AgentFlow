// `aflow route` — run a completion through the routing cascade.
//
// This is the command that turns the router from a library into a product: give
// it a prompt and a fallback order, and it returns the first model that
// actually answers -- with a receipt explaining everything it tried along the
// way.
//
//   aflow route "ping" --fallback oc/a,ocz/b,bzl/auto:free
//
// With no --fallback it uses the configured default model as the sole candidate,
// so it is safe to run anywhere.

import { defineCommand } from "../cli/registry.js";
import { Router, tiersFromList, classifyFailure, FAILURE } from "../core/routing.js";
import { complete, listModels } from "../core/gateway.js";
import { EventLog, EVENTS, defaultLogPath } from "../core/events.js";
import { bold, dim, heading, table, statusColor, green, red, yellow } from "../cli/ui.js";

function buildTiers(explicit, config) {
  if (explicit && explicit.length) {
    const list = explicit.map((m) => m.trim()).filter(Boolean);
    // One model per tier: the user listed them in preference order, so each
    // should be genuinely tried before the next rather than sharing attention.
    return list.map((model, i) => ({ name: `pref${i + 1}`, models: [model] }));
  }
  const model = config.defaultModel;
  if (!model) return null;
  return [{ name: "default", models: [model] }];
}

async function runRoute({ config, out, flags, args }) {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    const err = new Error("nothing to route: pass a prompt, e.g. aflow route \"ping\"");
    await out.init({ error: err.message }, () => err.message);
    return 2;
  }

  const explicit = typeof flags.fallback === "string" ? flags.fallback.split(",") : [];
  const tiers = buildTiers(explicit, config);
  if (!tiers) {
    const msg = "no model to route to: pass --fallback a,b,c or set a defaultModel";
    await out.init({ error: msg }, () => msg);
    return 2;
  }

  const log = new EventLog({
    file: flags["log-file"] || config.logPath || defaultLogPath(),
    level: config.logLevel,
  });

  // What the model list actually looks like, so a 404 is distinguishable from
  // a credential problem in the receipt. A Set of ids, because listModels
  // returns objects.
  let catalogue = null;
  try {
    const models = await listModels(config);
    catalogue = new Set(models.map((m) => m.id));
  } catch {
    /* optional context only */
  }

  const router = new Router({
    tiers,
    log,
    execute: async (model) => {
      log.emit(EVENTS.ROUTE_DECISION, { model, stage: "start", advertised: catalogue ? catalogue.has(model) : null });
      return complete(config, model, prompt);
    },
  });

  const receipt = await router.route();
  const attempts = receipt.attempts.map((a) => ({
    ...a,
    advertised: catalogue ? catalogue.has(a.model) : null,
  }));

  const payload = {
    prompt,
    ok: receipt.ok,
    model: receipt.model,
    tier: receipt.tier,
    // The router returns the executor's value on success; carry the text out of
    // it rather than expecting the router to know about response shapes.
    text: receipt.value?.text ?? null,
    totalMs: receipt.totalMs,
    attempts,
    skippedProviders: receipt.skippedProviders,
    failureKinds: receipt.failureKinds ?? [],
    error: receipt.ok ? null : String(receipt.error?.message ?? receipt.error),
    catalogueCount: catalogue ? catalogue.size : null,
  };

  await out.init(payload, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow route")));

    lines.push(
      table(
        [
          { k: "prompt", v: r.prompt },
          { k: "result", v: r.ok ? green(`answered by ${r.model}`) : red("no model answered") },
          ...(r.ok ? [{ k: "tier", v: r.tier }] : []),
          { k: "elapsed", v: `${r.totalMs}ms` },
        ],
        [
          { key: "k", label: "" },
          { key: "v", label: "" },
        ]
      )
    );

    if (r.catalogueCount != null) {
      lines.push("");
      lines.push(dim(`${r.catalogueCount} models advertised`));
    }

    lines.push("");
    lines.push(bold("attempts"));
    // Size the column to the data rather than a fixed guess: one long model id
    // was pushing every other row's timing out of alignment.
    const nameWidth = Math.max(...r.attempts.map((a) => a.model.length), 8);
    for (const a of r.attempts) {
      const mark = a.outcome === "ok" ? statusColor("ok") : a.outcome === "provider_skipped" ? dim("-") : statusColor("error");
      const adv = a.advertised === false ? yellow(" (not in catalogue)") : "";
      const why = a.error ? dim(`  ${a.error}`) : a.outcome === "empty" ? dim("  200 with no content") : "";
      lines.push(`  ${mark} ${a.model.padEnd(nameWidth)} ${String(`${a.elapsedMs}ms`).padStart(7)}${adv}${why}`);
    }

    if (r.ok && r.text) {
      lines.push("");
      lines.push(bold("response"));
      lines.push(r.text);
    }

    if (!r.ok) {
      lines.push("");
      lines.push(red(r.error));
      lines.push("");
      if (r.failureKinds.includes(FAILURE.NO_CREDENTIALS)) {
        lines.push(dim("providers advertising models without active credentials is the usual cause."));
        lines.push(dim("run `aflow doctor` to see which providers are configured."));
      } else if (r.failureKinds.includes(FAILURE.EMPTY)) {
        lines.push(dim("providers returned HTTP 200 with zero content. That is a working"));
        lines.push(dim("connection to a dead model, not a working model."));
      }
      lines.push("");
      lines.push(dim(`full receipt: aflow logs --type route.decision`));
    }

    if (r.skippedProviders.length) {
      lines.push("");
      lines.push(dim(`skipped providers: ${r.skippedProviders.join(", ")}`));
    }
    return lines.join("\n");
  });

  return receipt.ok ? 0 : 1;
}

export const routeCommand = defineCommand("route", {
  summary: "run a completion through the fallback cascade",
  valueFlags: ["fallback", "log-file"],
  usage: `aflow route <prompt> [--fallback a,b,c] [--json]

Sends the prompt to the first model that actually answers, walking a fallback
order and recording why each step failed.

  --fallback LIST   comma-separated preference order; each model gets its own
                    tier so it is genuinely tried first
  --log-file PATH   write the routing receipt to a specific log

Exit codes: 0 answered, 1 nothing answered, 2 nothing to route to.

Examples
  aflow route "ping" --fallback oc/muse,ocz/deepseek,bzl/auto:free
  aflow route "ping" --fallback oc/muse,bzl/auto:free --json | jq .model

A model being in the catalogue means nothing. This command exists to find the
ones that return content.`,
  run: runRoute,
});

export default routeCommand;