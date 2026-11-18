// `aflow mode` — select, inspect, and switch operating modes.
//
// Modes: Plan → Build → Orchestrate → Auto.
// Tab cycles through modes in the TUI; this command is the CLI surface.
//
//   aflow mode                 show current mode and policy
//   aflow mode status          alias for show
//   aflow mode list            list all modes with descriptions
//   aflow mode switch <mode>   switch to a mode (Plan|Build|Orchestrate|Auto)
//
// Switching to a more privileged mode triggers the existing permission and
// approval checks. Context (session, blackboard, plan) is preserved across
// switches.

import { defineCommand } from "../cli/registry.js";
import { Output } from "../cli/output.js";
import { bold, dim, red, green, yellow, cyan } from "../cli/ui.js";
import {
  MODE,
  MODE_NAMES,
  MODE_DESCRIPTIONS,
  MODE_CYCLE,
  getModePolicy,
  getDefaultMode,
  nextMode,
  ModeRegistry,
} from "../core/modes/index.js";

const VALID_MODE_NAMES = new Set(Object.values(MODE));

function normalizeMode(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (VALID_MODE_NAMES.has(key)) return key;
  // Also accept capitalized forms: "Plan" -> "plan"
  const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
  const byName = Object.entries(MODE_NAMES).find(([, name]) => name.toLowerCase() === key);
  if (byName) return byName[0];
  return null;
}

export async function run({ args, flags, config, out }) {
  const [sub = "status", ...rest] = args;

  // Build a minimal mode registry backed by the event log and session store
  // if available through config. Without stores, mode state is in-process only
  // (reset on each CLI invocation — appropriate for stateless commands).
  const eventLog = config?.logPath ? null : null; // CLI commands are stateless; no persistence
  const registry = new ModeRegistry({ eventLog });

  // Switching modes on the CLI: each invocation is a fresh process, so
  // `mode switch` sets the mode for that invocation only. Persistent mode
  // state lives in the TUI session and the session store.
  registry.initialize({ mode: getDefaultMode() });

  switch (sub) {
    case "status":
    case "show":
    case "": {
      const current = registry.getMode();
      const policy = registry.getPolicy();
      const next = nextMode(current);
      const isEscalation = (t) => registry.isEscalation(t);

      const lines = [];
      lines.push(bold("aflow mode — current operating mode"));
      lines.push("");
      lines.push(`  mode:      ${bold(cyan(current.toUpperCase()))}  ${dim(MODE_DESCRIPTIONS[current])}`);
      lines.push(`  next tab:  ${dim(next.toUpperCase())}  (press Tab in the TUI to cycle)`);
      lines.push(`  privilege: ${dim(MODE_PRIVILEGE_LEVELS[current] || 0)}`);
      lines.push("");
      lines.push(bold("policy"));
      lines.push(`  scopes:          ${dim(policy.scopes.join(", "))}`);
      lines.push(`  allow:           ${dim(policy.allow.length ? policy.allow.join(", ") : "(none)")}`);
      lines.push(`  ask:             ${dim(policy.ask.length ? policy.ask.join(", ") : "(none)")}`);
      lines.push(`  requireApproval: ${dim(policy.requireApproval.join(", ") || "(none)")}`);
      lines.push(`  allowedAgents:   ${dim(policy.allowedAgentIds.join(", "))}`);
      lines.push(`  maxSubagents:    ${dim(String(policy.maxSubagents))}`);
      lines.push(`  securityGate:    ${dim(policy.securityGateRequired ? "required" : "not required")}`);
      lines.push(`  modelRequires:   ${dim(policy.modelRequirements.join(", ") || "(none)")}`);
      lines.push(`  maxIterations:   ${dim(String(policy.maxIterations))}`);
      lines.push(`  maxToolCalls:    ${dim(String(policy.maxToolCalls))}`);
      lines.push(`  timeout:         ${dim(`${Math.round(policy.timeoutMs / 1000)}s`)}`);
      lines.push("");
      lines.push(bold("available modes"));
      for (const m of MODE_CYCLE) {
        const marker = m === current ? green("●") : dim("○");
        const escalation = m === current ? "" : isEscalation(m) ? `  ${yellow("(escalation)")}` : "";
        lines.push(`  ${marker} ${m.toUpperCase().padEnd(12)} ${dim(MODE_DESCRIPTIONS[m])}${escalation}`);
      }
      lines.push("");
      lines.push(dim("switch:  aflow mode switch <plan|build|orchestrate|auto>"));
      lines.push(dim("TUI:     press Tab to cycle modes"));

      await out.init({ mode: current, policy }, () => lines.join("\n"));
      return 0;
    }

    case "list": {
      const lines = [];
      lines.push(bold("aflow mode — available operating modes"));
      lines.push("");
      const header = ["mode", "description", "scopes", "maxSubagents", "securityGate"];
      const rows = [];
      for (const m of MODE_CYCLE) {
        const p = getModePolicy(m);
        rows.push([
          m.toUpperCase(),
          MODE_DESCRIPTIONS[m],
          p.scopes.join(", "),
          String(p.maxSubagents),
          p.securityGateRequired ? "required" : "no",
        ]);
      }
      // Simple table render
      lines.push(rows.map((r) => r.join("  |  ")).join("\n"));
      lines.push("");
      lines.push(dim("current: " + (registry.getMode() || getDefaultMode()).toUpperCase()));
      lines.push(dim("switch:  aflow mode switch <mode>"));

      await out.init({ modes: MODE_CYCLE }, () => lines.join("\n"));
      return 0;
    }

    case "switch": {
      const target = normalizeMode(rest[0]);
      if (!target) {
        const lines = [];
        lines.push(bold("aflow mode switch — specify a mode"));
        lines.push("");
        lines.push(`  usage: aflow mode switch <${MODE_CYCLE.join("|")}>`);
        lines.push("");
        lines.push(bold("modes:"));
        for (const m of MODE_CYCLE) {
          lines.push(`  ${m.toUpperCase().padEnd(12)} ${dim(MODE_DESCRIPTIONS[m])}`);
        }
        await out.init({ error: "missing mode" }, () => lines.join("\n"));
        return 2;
      }

      const current = registry.getMode();
      const policy = getModePolicy(target);
      const isEsc = policy.isEscalation(current);

      // For CLI, switching to a more privileged mode requires --yes unless
      // the user explicitly accepts. We check flags.yes; if not set and it's
      // an escalation, require confirmation via the interactive approver.
      if (isEsc && !(flags.yes === true || flags.yes === "true")) {
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!interactive) {
          const lines = [];
          lines.push(bold("aflow mode switch — approval required"));
          lines.push("");
          lines.push(`  switching ${current.toUpperCase()} → ${target.toUpperCase()} is a privilege escalation`);
          lines.push("");
          lines.push(dim("  re-run with --yes to confirm, or switch in the TUI (Tab)"));
          await out.init({ from: current, to: target, escalation: true }, () => lines.join("\n"));
          return 1;
        }

        // Interactive: ask the user.
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(
            `switch ${current.toUpperCase()} → ${target.toUpperCase()} (privilege escalation)? [y/N] `,
          );
          rl.close();
          if ((answer || "").trim().toLowerCase() !== "y") {
            await out.init({ from: current, to: target, cancelled: true }, () => "mode switch cancelled\n");
            return 1;
          }
        } catch {
          rl.close();
          await out.init({ from: current, to: target, error: "approval failed" }, () => "mode switch: approval failed\n");
          return 1;
        }
      }

      const result = await registry.switchTo(target, {
        reason: "cli mode switch",
        approver: undefined, // CLI handles approval above
      });

      if (!result.ok) {
        await out.init({ error: result.error }, () => `mode switch failed: ${result.error}\n`);
        return 1;
      }

      // Persist if possible (best-effort).
      try {
        await registry.persist();
      } catch {
        /* persistence is best-effort */
      }

      const lines = [];
      lines.push(bold("aflow mode switched"));
      lines.push("");
      lines.push(`  from: ${dim(current.toUpperCase())}`);
      lines.push(`  to:   ${bold(cyan(target.toUpperCase()))}  ${dim(MODE_DESCRIPTIONS[target])}`);
      lines.push(`  policy: scopes=${dim(policy.scopes.join(", "))}`);
      if (isEsc) lines.push(dim("  (privilege escalation — approvals re-run on next gated action)"));
      lines.push("");
      lines.push(dim("context preserved: session, blackboard, plan, TODO"));

      await out.init({ from: current, to: target, policy }, () => lines.join("\n"));
      return result.switched ? 0 : 0;
    }

    case "cycle": {
      const result = await registry.cycle({ reason: "cli mode cycle" });
      if (!result.ok) {
        await out.init({ error: result.error }, () => `mode cycle failed: ${result.error}\n`);
        return 1;
      }
      const lines = [];
      lines.push(bold("aflow mode cycled"));
      lines.push("");
      lines.push(`  from: ${dim(result.previousMode.toUpperCase())}`);
      lines.push(`  to:   ${bold(cyan(result.newMode.toUpperCase()))}  ${dim(MODE_DESCRIPTIONS[result.newMode])}`);
      lines.push("");
      await out.init({ from: result.previousMode, to: result.newMode }, () => lines.join("\n"));
      return 0;
    }

    default: {
      const lines = [];
      lines.push(bold("aflow mode — operating modes"));
      lines.push("");
      lines.push("usage:");
      lines.push("  aflow mode                 show current mode and policy");
      lines.push("  aflow mode list            list all modes");
      lines.push("  aflow mode switch <mode>   switch mode (plan|build|orchestrate|auto)");
      lines.push("  aflow mode cycle           cycle to next mode (Tab order)");
      lines.push("");
      lines.push(bold("modes:"));
      for (const m of MODE_CYCLE) {
        lines.push(`  ${m.toUpperCase().padEnd(12)} ${dim(MODE_DESCRIPTIONS[m])}`);
      }
      lines.push("");
      lines.push(dim("TUI: press Tab to cycle modes. CLI: aflow mode switch <mode>."));
      await out.init({ modes: MODE_CYCLE }, () => lines.join("\n"));
      return 0;
    }
  }
}

defineCommand("mode", {
  summary: "select, inspect, and switch operating modes (plan|build|orchestrate|auto)",
  valueFlags: [],
  run,
});

export default { run };

// Privilege levels used by the status display.
const MODE_PRIVILEGE_LEVELS = {
  [MODE.PLAN]: 1,
  [MODE.BUILD]: 2,
  [MODE.ORCHESTRATE]: 2,
  [MODE.AUTO]: 3,
};
