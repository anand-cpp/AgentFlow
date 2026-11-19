// `aflow security` — security orchestration commands.
//
// Runs scan profiles, shows findings, manages remediation, and evaluates
// the delivery gate. Integrates with the SecurityOrchestrator and the
// existing AgentFlow CLI architecture.

import { defineCommand } from "../cli/registry.js";
import { bold, dim, red, green, yellow, cyan } from "../cli/ui.js";
import { SecurityOrchestrator, SCAN_PROFILES } from "../security/orchestrator.js";
import { SemgrepScanner } from "../security/scanners/semgrep.js";
import { OsvScanner } from "../security/scanners/osv.js";
import { TrivyScanner } from "../security/scanners/trivy.js";

const _TABLE_WIDTH = 80;

function buildOrchestrator() {
  const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
  orch.registerScanner(new SemgrepScanner());
  orch.registerScanner(new OsvScanner());
  orch.registerScanner(new TrivyScanner());
  return orch;
}

function renderFinding(finding) {
  const sevColor = {
    critical: red,
    high: red,
    medium: yellow,
    low: cyan,
    info: dim,
  }[finding.severity] || dim;

  const lines = [];
  lines.push(`  ${bold(finding.title || finding.ruleId || "finding")}`);
  lines.push(`    scanner: ${finding.scannerId}  rule: ${finding.ruleId || "—"}`);
  lines.push(`    severity: ${sevColor(finding.severity.toUpperCase())}  confidence: ${finding.confidence}`);
  lines.push(`    status: ${finding.verificationStatus}`);
  if (finding.file) lines.push(`    file: ${finding.file}${finding.line ? ":" + finding.line : ""}`);
  if (finding.dependencyPath) lines.push(`    dependency: ${finding.dependencyPath}`);
  if (finding.description) lines.push(`    ${dim(finding.description)}`);
  lines.push("");
  return lines.join("\n");
}

export async function run({ args, flags, _config, out }) {
  const [sub = "help"] = args;
  const orch = buildOrchestrator();

  switch (sub) {
    case "scan": {
      const [profile = "standard"] = args.slice(1);
      const target = flags.target || process.cwd();

      out.init({ profile, target }, () => {
        const lines = [];
        lines.push(bold(`Security scan — profile: ${profile}`));
        lines.push(`target: ${target}`);
        lines.push("");
        return lines.join("\n");
      });

      const session = await orch.runProfile(profile, target, { timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined });

      const summaryLines = [];
      summaryLines.push(bold("Scan complete"));
      summaryLines.push(`profile: ${session.profile}`);
      summaryLines.push(`scanners run: ${session.results.filter((r) => r.status === "completed").length}/${session.results.length}`);
      summaryLines.push(`findings: ${session.findingsSummary.total}`);
      summaryLines.push(`  critical: ${session.findingsSummary.critical}`);
      summaryLines.push(`  high: ${session.findingsSummary.high}`);
      summaryLines.push(`  medium: ${session.findingsSummary.medium}`);
      summaryLines.push(`  low: ${session.findingsSummary.low}`);
      summaryLines.push("");
      summaryLines.push(bold("Scanner status:"));
      for (const r of session.results) {
        const statusColor = r.status === "completed" ? green : r.status === "blocked" ? yellow : red;
        summaryLines.push(`  ${r.scannerId}: ${statusColor(r.status)}`);
      }
      out.detail(summaryLines.join("\n"));
      return 0;
    }

    case "findings": {
      const findings = orch.findingsEngine.getAll();
      out.init({ count: findings.length }, () => {
        const lines = [];
        lines.push(bold(`Security findings (${findings.length})`));
        lines.push("");
        for (const f of findings) {
          lines.push(renderFinding(f));
        }
        return lines.join("\n");
      });
      return 0;
    }

    case "critical":
    case "high": {
      const sev = sub === "critical" ? "critical" : "high";
      const findings = orch.findingsEngine.getBySeverity(sev);
      out.init({ count: findings.length, severity: sev }, () => {
        const lines = [];
        lines.push(bold(`${sev.toUpperCase()} findings (${findings.length})`));
        lines.push("");
        for (const f of findings) {
          lines.push(renderFinding(f));
        }
        return lines.join("\n");
      });
      return 0;
    }

    case "history": {
      const history = orch.getHistory(Number(flags.limit) || 10);
      out.init({ count: history.length }, () => {
        const lines = [];
        lines.push(bold("Security scan history"));
        lines.push("");
        for (const s of history) {
          lines.push(`  ${s.id}  ${s.profile}  ${s.target}`);
          lines.push(`    findings: ${s.findingsSummary.total} (c:${s.findingsSummary.critical} h:${s.findingsSummary.high})`);
          lines.push(`    started: ${s.startedAt}`);
          lines.push("");
        }
        return lines.join("\n");
      });
      return 0;
    }

    case "rescan": {
      const [profile = "standard"] = args.slice(1);
      const target = flags.target || process.cwd();
      orch.clearFindings();
      const session = await orch.runProfile(profile, target);
      out.init({ profile }, () => {
        const lines = [];
        lines.push(bold(`Rescan complete — profile: ${profile}`));
        lines.push(`findings: ${session.findingsSummary.total}`);
        lines.push(`  critical: ${session.findingsSummary.critical}`);
        lines.push(`  high: ${session.findingsSummary.high}`);
        return lines.join("\n");
      });
      return 0;
    }

    case "verify": {
      const gate = orch.evaluateDeliveryGate({ profile: flags.profile || "standard" });
      out.init({ status: gate.status, eligible: gate.eligible }, () => {
        const lines = [];
        const statusColor = gate.eligible ? green : red;
        lines.push(bold("Delivery gate evaluation"));
        lines.push(`status: ${statusColor(gate.status.toUpperCase())}`);
        lines.push(`eligible: ${gate.eligible ? green("yes") : red("no")}`);
        lines.push("");
        if (gate.reasons.length > 0) {
          lines.push(bold("Reasons:"));
          for (const r of gate.reasons) lines.push(`  - ${r}`);
          lines.push("");
        }
        lines.push(bold("Summary:"));
        lines.push(`  total: ${gate.summary.total}`);
        lines.push(`  critical: ${gate.summary.critical}`);
        lines.push(`  high: ${gate.summary.high}`);
        lines.push(`  needing remediation: ${gate.summary.needingRemediation}`);
        return lines.join("\n");
      });
      return gate.eligible ? 0 : 1;
    }

    case "report": {
      const gate = orch.evaluateDeliveryGate();
      const summary = orch.findingsEngine.summary();
      out.init({}, () => {
        const lines = [];
        lines.push(bold("Security Report"));
        lines.push(`generated: ${new Date().toISOString()}`);
        lines.push(`delivery status: ${gate.status}`);
        lines.push(`eligible: ${gate.eligible}`);
        lines.push("");
        lines.push(bold("Findings by severity:"));
        lines.push(`  critical: ${summary.critical}`);
        lines.push(`  high: ${summary.high}`);
        lines.push(`  medium: ${summary.medium}`);
        lines.push(`  low: ${summary.low}`);
        lines.push(`  info: ${summary.info}`);
        lines.push("");
        lines.push(bold("Scanner coverage:"));
        for (const [id, cov] of Object.entries(summary.scannerCoverage)) {
          lines.push(`  ${id}: ${cov.status} (${cov.findingCount} findings)`);
        }
        return lines.join("\n");
      });
      return 0;
    }

    case "tools": {
      const availability = await orch.probeScanners();
      out.init({}, () => {
        const lines = [];
        lines.push(bold("Security tool availability"));
        lines.push("");
        for (const [id, info] of Object.entries(availability)) {
          const statusColor = info.available ? green : red;
          lines.push(`  ${id}: ${statusColor(info.available ? "available" : "unavailable")}`);
          if (info.reason) lines.push(`    ${dim(info.reason)}`);
        }
        return lines.join("\n");
      });
      return 0;
    }

    case "help":
    default:
      out.init({}, () => {
        const lines = [];
        lines.push(bold("aflow security — security orchestration"));
        lines.push("");
        lines.push("Commands:");
        lines.push("  scan [profile]     Run a security scan (quick|standard|deep|release)");
        lines.push("  findings           List all security findings");
        lines.push("  critical           List critical findings");
        lines.push("  high               List high findings");
        lines.push("  history            Show scan history");
        lines.push("  rescan [profile]   Clear findings and re-scan");
        lines.push("  verify             Evaluate the delivery gate");
        lines.push("  report             Generate a security report");
        lines.push("  tools              Check scanner tool availability");
        lines.push("");
        lines.push("Global flags:");
        lines.push("  --target PATH      Target directory to scan (default: cwd)");
        lines.push("  --timeout-ms MS    Scanner timeout in milliseconds");
        lines.push("  --profile NAME     Scan profile for verify command");
        return lines.join("\n");
      });
      return 0;
  }
}

defineCommand("security", {
  summary: "security orchestration — scans, findings, remediation, delivery gate",
  valueFlags: ["target", "timeout-ms", "profile"],
  run,
});

export default { run };
