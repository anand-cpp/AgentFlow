// `aflow doctor` — environment and provider diagnostics.
//
// This is the command that earns the CLI its keep. Upstream's dashboard
// advertises 790 models; a fresh install with no credentials reaches almost
// none of them. The single most useful thing a terminal tool can report is the
// gap between "advertised" and "actually works", so doctor measures reality
// rather than echoing a catalogue.

import { defineCommand } from "../cli/registry.js";
import { ping, probeModel, getVersion } from "../core/gateway.js";
import { projectConfigPaths, globalConfigPath } from "../config/index.js";
import { bold, dim, table, heading, symbol, statusColor, green, red, yellow } from "../cli/ui.js";
import { oauthClientConfigured } from "../../open-sse/providers/shared.js";
import { EventLog, EVENTS, defaultLogPath } from "../core/events.js";

/**
 * Candidate models worth probing when the user hasn't named one.
 * Chosen to cover distinct providers rather than to be exhaustive — probing
 * 790 models would take minutes and tell you nothing extra.
 */
const DEFAULT_CANDIDATES = [
  "oc/muse-spark-1.3-contributor-free",
  "ocz/deepseek-v4-flash-free",
  "bzl/auto:free",
];

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node",
    status: major >= 20 ? "ok" : "error",
    detail: `${process.versions.node}${major >= 20 ? "" : " (>=20 required)"}`,
  };
}

function checkConfig() {
  const project = projectConfigPaths();
  const global = globalConfigPath();
  const sources = [];
  if (project.length) sources.push(`${project.length} project file(s)`);
  sources.push("defaults");
  return {
    name: "config",
    status: "ok",
    detail: sources.join(" + "),
  };
}

function checkOAuthClients() {
  const rows = [];
  for (const [name, envName] of [["GOOGLE", "GOOGLE"], ["ANTIGRAVITY", "ANTIGRAVITY"]]) {
    const configured = oauthClientConfigured(envName);
    rows.push({
      name: `${name.toLowerCase()}-oauth`,
      status: configured ? "ok" : "unconfigured",
      detail: configured
        ? "credentials supplied via env"
        : `set ${envName}_OAUTH_CLIENT_ID and ${envName}_OAUTH_CLIENT_SECRET to enable`,
    });
  }
  return rows;
}

async function runDoctor({ config, out, flags }) {
  const checks = [];

  // Every probe outcome becomes an event, so `aflow logs --type gateway.probe`
  // can answer "was this provider ever working?" over time rather than only
  // describing one moment.
  const log = new EventLog({
    file: flags["log-file"] || config.logPath || defaultLogPath(),
    level: config.logLevel,
  });

  checks.push(checkNodeVersion());
  checks.push(checkConfig());
  checks.push(...checkOAuthClients());

  const pinged = await ping(config);
  checks.push({
    name: "gateway",
    status: pinged.ok ? "ok" : "error",
    detail: pinged.ok
      ? `${config.baseUrl} reachable in ${pinged.elapsedMs}ms`
      : `${config.baseUrl} — ${pinged.error}`,
  });

  log.emit(
    pinged.ok ? EVENTS.GATEWAY_PROBE : EVENTS.GATEWAY_ERROR,
    { baseUrl: config.baseUrl, elapsedMs: pinged.elapsedMs, error: pinged.error },
    pinged.ok ? "info" : "error"
  );

  let version = null;
  let catalogueCount = null;
  const probes = [];

  if (pinged.ok) {
    try {
      version = await getVersion(config);
    } catch {
      /* version is informational only */
    }

    const candidates = config.defaultModel
      ? [config.defaultModel, ...DEFAULT_CANDIDATES.filter((m) => m !== config.defaultModel)]
      : DEFAULT_CANDIDATES;

    out.status(dim(`probing ${candidates.length} model(s)…`));
    for (const model of candidates) {
      const result = await probeModel(config, model);
      probes.push(result);
      checks.push({
        name: model,
        status: result.status,
        detail: result.status === "ok"
          ? `reachable in ${result.elapsedMs}ms`
          : result.detail,
      });
      log.emit(EVENTS.GATEWAY_PROBE, { model, status: result.status, elapsedMs: result.elapsedMs, detail: result.detail },
        result.status === "ok" ? "info" : result.status === "empty" ? "warn" : "error");
    }

    // Count the advertised catalogue for contrast with what actually works.
    try {
      const { listModels } = await import("../core/gateway.js");
      catalogueCount = (await listModels(config)).length;
    } catch {
      /* optional */
    }
  }

  const reachable = probes.filter((p) => p.status === "ok").length;
  const summary = {
    node: process.versions.node,
    baseUrl: config.baseUrl,
    gatewayUp: pinged.ok,
    gatewayVersion: version?.currentVersion ?? null,
    catalogueCount,
    probed: probes.length,
    reachable,
    // The headline finding, stated plainly: advertised vs actually working.
    note:
      catalogueCount && reachable < probes.length
        ? `${catalogueCount} models advertised; ${reachable}/${probes.length} probed actually returned content. A listed model is not a working model — providers without active credentials fail at request time.`
        : null,
    checks,
    probes,
  };

  await out.init(summary, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow doctor")));
    lines.push(
      table(
        r.checks.map((c) => ({
          check: c.name,
          status: statusColor(c.status),
          detail: c.detail ?? "",
        })),
        [
          { key: "check", label: "CHECK" },
          { key: "status", label: "STATUS" },
          { key: "detail", label: "DETAIL", max: 68 },
        ]
      )
    );

    if (r.catalogueCount) {
      lines.push("");
      lines.push(bold("Reachability"));
      const okCount = r.reachable;
      const line = `${r.catalogueCount} models advertised, ${okCount}/${r.probed} probed returned content`;
      lines.push(okCount === 0 ? red(line) : okCount < r.probed.length ? yellow(line) : green(line));
    }
    if (r.note) {
      lines.push("");
      lines.push(dim(r.note));
    }

    const errors = r.checks.filter((c) => c.status === "error").length;
    const warns = r.checks.filter((c) => c.status === "warn" || c.status === "unconfigured").length;
    lines.push("");
    lines.push(
      errors
        ? red(`${symbol("fail")} ${errors} problem(s) found`)
        : warns
          ? yellow(`${symbol("warn")} ${warns} item(s) need attention`)
          : green(`${symbol("ok")} all checks passed`)
    );
    return lines.join("\n");
  });

  const errors = checks.filter((c) => c.status === "error").length;
  return errors ? 1 : 0;
}

export const doctorCommand = defineCommand("doctor", {
  valueFlags: ["log-file"],
  summary: "check environment, gateway, and live provider reachability",
  usage: `aflow doctor [--verbose]

Runs environment checks, probes the gateway, and tests whether advertised
models actually return content.

Exit code is non-zero if any check fails.`,
  run: ({ config, out, flags }) => runDoctor({ config, out, flags }),
});

export default doctorCommand;