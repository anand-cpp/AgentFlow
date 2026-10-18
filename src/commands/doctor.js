// `aflow doctor` — environment and provider diagnostics.
//
// This is the command that earns the CLI its keep. Upstream's dashboard
// advertises 790 models; a fresh install with no credentials reaches almost
// none of them. The single most useful thing a terminal tool can report is the
// gap between "advertised" and "actually works", so doctor measures reality
// rather than echoing a catalogue.

import { defineCommand } from "../cli/registry.js";
import { ping, probeModel, getVersion } from "../core/gateway.js";
import { projectConfigPaths } from "../config/index.js";
import { bold, dim, table, heading, symbol, statusColor, green, red, yellow } from "../cli/ui.js";
import { oauthClientConfigured } from "../../open-sse/providers/shared.js";
import { EventLog, EVENTS, defaultLogPath } from "../core/events.js";
import { defaultKeysFile, readKeysFile, mergeEnv, configuredProviderNames } from "../core/keys.js";
import { PROVIDERS } from "../core/gateway-server.js";
import { findGitRoot, validateGitAvailable } from "../core/git/discover.js";
import { detectInstalledServers } from "../core/lsp/registry.js";
import { getMcpServers } from "../core/mcp/config.js";
import { execFile } from "node:child_process";

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
  const sources = [];
  if (project.length) sources.push(`${project.length} project file(s)`);
  sources.push("defaults");
  return {
    name: "config",
    status: "ok",
    detail: sources.join(" + "),
  };
}

/**
 * Report whether git is usable. The git integration is optional, so a missing
 * binary is a warning (git tools are disabled), not a failing check: doctor
 * should not exit non-zero for a machine that simply has no git.
 */
async function checkGit() {
  const avail = await validateGitAvailable();
  if (!avail.ok) {
    return {
      name: "git",
      status: "warn",
      detail: `git not found on PATH — git tools disabled (${avail.error})`,
    };
  }
  const repo = findGitRoot(process.cwd());
  return {
    name: "git",
    status: "ok",
    detail: `git ${avail.version}${repo.ok ? ` — repository at ${repo.root}` : " — current directory is not a repository"}`,
  };
}

/**
 * Turn a gateway ping outcome into a check status.
 *
 * An offline local daemon is not a failure. AgentFlow talks to any
 * OpenAI-compatible gateway, and the in-repo one is optional: a machine that
 * simply has not started `aflow server` should not be told it has a problem.
 * A connect refusal or timeout therefore reads as `offline` (informational),
 * while a server that is up but broken -- an HTTP 5xx -- stays a hard error.
 */
function classifyGateway(pinged) {
  if (pinged.ok) {
    return { status: "ok", detail: `reachable in ${pinged.elapsedMs}ms` };
  }
  if (pinged.code === "unreachable" || pinged.code === "timeout") {
    return { status: "offline", detail: "offline (optional daemon; start with `aflow server`)" };
  }
  if (typeof pinged.status === "number" && pinged.status >= 500) {
    return { status: "error", detail: pinged.error };
  }
  return { status: "warn", detail: pinged.error };
}

/**
 * Report which language servers are on PATH.
 *
 * Like git, LSP is optional: a machine with none installed simply has no
 * diagnostics feedback. That is informational, never a failing check, so this
 * never returns `error`.
 */
async function checkLanguageServers(detect) {
  const servers = await detect();
  const installed = servers.filter((s) => s.installed);
  if (!installed.length) {
    return {
      name: "lsp",
      status: "unconfigured",
      detail: "no language servers on PATH — install one (e.g. `npm i -g typescript-language-server typescript`) to enable diagnostics",
    };
  }
  return {
    name: "lsp",
    status: "ok",
    detail: `${installed.length} server(s) available (${installed.map((s) => s.id).join(", ")})`,
  };
}

/**
 * Probe whether an MCP stdio command resolves on PATH.
 * @param {string} command
 * @returns {Promise<boolean>}
 */
function probeCommand(command) {
  const WHICH = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(WHICH, [command], { timeout: 4000, windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Report configured MCP servers.
 *
 * Like LSP, MCP is optional: a project without mcp.json is `unconfigured`, and a
 * configured server whose binary is missing from PATH is informational — never
 * an error, because doctor must not fail on an offline or disabled server.
 */
async function checkMcpServers(load) {
  const servers = await load();
  if (!servers.length) {
    return {
      name: "mcp",
      status: "unconfigured",
      detail: "no MCP servers configured — add mcp.json or .agentflow/mcp.json with an `mcpServers` block",
    };
  }
  const results = await Promise.all(
    servers.map(async (s) => {
      if (s.type !== "stdio") return { name: s.name, command: s.url ?? "<sse>", found: true };
      const found = await probeCommand(s.command);
      return { name: s.name, command: s.command, found };
    }),
  );
  const names = results.map((r) => r.name).join(", ");
  const missing = results.filter((r) => !r.found);
  if (missing.length === results.length) {
    return {
      name: "mcp",
      status: "info",
      detail: `${results.length} server(s) configured (${names}) — ${missing.map((m) => m.command).join(", ")} not found on PATH`,
    };
  }
  if (missing.length) {
    return {
      name: "mcp",
      status: "warn",
      detail: `${results.length - missing.length}/${results.length} configured servers ready (${names}) — ${missing.map((m) => m.command).join(", ")} not found on PATH`,
    };
  }
  return {
    name: "mcp",
    status: "ok",
    detail: `${results.length} server(s) configured (${names})`,
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

/**
 * Report which providers the gateway can actually authenticate.
 *
 * Keys come from `aflow setup`'s keys.env merged under process.env. A provider
 * with a key is "ok"; having none at all is "unconfigured" and points at the
 * wizard, because the single most common fresh-install problem is simply not
 * having run it.
 */
function checkProviderKeys() {
  const keysFile = defaultKeysFile();
  const merged = mergeEnv(readKeysFile(keysFile), process.env);
  const configured = configuredProviderNames(merged, PROVIDERS);
  return {
    name: "provider-keys",
    status: configured.length ? "ok" : "unconfigured",
    detail: configured.length
      ? `${configured.length} provider(s) configured (${configured.join(", ")}) — ${keysFile}`
      : `no provider keys configured — run \`aflow setup\` (looked in ${keysFile})`,
  };
}

/**
 * @param {{ config: object, out: object, flags: Record<string, unknown>, deps?: Record<string, Function> }} args
 */
async function runDoctor({ config, out, flags, deps = {} }) {
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
  checks.push(await checkGit());
  checks.push(checkProviderKeys());
  checks.push(...checkOAuthClients());
  checks.push(await checkLanguageServers(deps.detectServers ?? detectInstalledServers));
  checks.push(await checkMcpServers(deps.mcpServers ?? (() => getMcpServers(process.cwd()))));

  const probeGateway = deps.ping ?? ping;
  const pinged = await probeGateway(config);
  const gateway = classifyGateway(pinged);
  checks.push({
    name: "gateway",
    status: gateway.status,
    detail: `${config.baseUrl} — ${gateway.detail}`,
  });

  const gatewayFailed = gateway.status === "error";
  log.emit(
    gatewayFailed ? EVENTS.GATEWAY_ERROR : EVENTS.GATEWAY_PROBE,
    { baseUrl: config.baseUrl, elapsedMs: pinged.elapsedMs, error: pinged.error, code: pinged.code ?? null },
    gatewayFailed ? "error" : "info"
  );

  let version = null;
  let catalogueCount = null;
  const probes = [];

  if (pinged.ok) {
    const getVersionFn = deps.getVersion ?? getVersion;
    const probeModelFn = deps.probeModel ?? probeModel;
    try {
      version = await getVersionFn(config);
    } catch {
      /* version is informational only */
    }

    const candidates = config.defaultModel
      ? [config.defaultModel, ...DEFAULT_CANDIDATES.filter((m) => m !== config.defaultModel)]
      : DEFAULT_CANDIDATES;

    out.status(dim(`probing ${candidates.length} model(s)…`));
    for (const model of candidates) {
      const result = await probeModelFn(config, model);
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
      const listModelsFn = deps.listModels ?? (await import("../core/gateway.js")).listModels;
      catalogueCount = (await listModelsFn(config)).length;
    } catch {
      /* optional */
    }
  }

  const reachable = probes.filter((p) => p.status === "ok").length;
  const summary = {
    node: process.versions.node,
    baseUrl: config.baseUrl,
    gatewayUp: pinged.ok,
    gatewayStatus: gateway.status,
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

  Exit code is non-zero if any check fails. An offline gateway daemon is
  reported as "offline" rather than a failure, and does not affect the exit
  code.`,
  run: ({ config, out, flags, deps = {} }) => runDoctor({ config, out, flags, deps }),
});

export default doctorCommand;