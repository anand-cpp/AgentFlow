// `aflow skill-scan` — scan a skill source with SkillSpector before activation.
//
// Runs the SkillSpector security scanner against a skill source directory.
// A skill must pass the security scan before it can be activated.
// Results are reported and the skill state is updated accordingly.

import { defineCommand } from "../cli/registry.js";
import { Output } from "../cli/output.js";
import { bold, dim, red, green, yellow } from "../cli/ui.js";
import { SkillSpectorEngine, SKILL_STATE } from "../security/skill-spector/engine.js";

export async function run({ args, flags, config, out }) {
  const [skillPath] = args;

  if (!skillPath) {
    out.error("aflow skill-scan requires a skill source path");
    out.error(dim("Usage: aflow skill-scan <skill-path>"));
    return 2;
  }

  const engine = new SkillSpectorEngine();
  const skillId = `skill-${Date.now().toString(36).slice(-6)}`;

  try {
    engine.registerSkill({
      id: skillId,
      name: skillPath.split("/").pop() || skillPath,
      source: skillPath,
      commit: null,
    });
  } catch (err) {
    out.error(`Failed to register skill: ${err.message}`);
    return 1;
  }

  const result = await engine.scanSkill(skillId, { targetPath: skillPath });

  out.init({ skill: skillId, state: result.state }, () => {
    const lines = [];
    lines.push(bold(`SkillScan: ${skillId}`));
    lines.push(`source: ${skillPath}`);
    lines.push(`state: ${result.state}`);
    lines.push(`scanner: skill-spector`);
    lines.push(`scanned at: ${result.scannedAt}`);

    if (result.error) {
      lines.push(`error: ${result.error.message}`);
      return lines.join("\n");
    }

    if (result.findings.length > 0) {
      lines.push(`findings: ${result.findings.length}`);
      for (const f of result.findings) {
        const sevColor = f.severity === "critical" || f.severity === "high" ? red : yellow;
        lines.push(`  ${sevColor(f.severity.toUpperCase())} ${f.title}`);
        lines.push(`    rule: ${f.ruleId}`);
        if (f.file) lines.push(`    file: ${f.file}${f.line ? ":" + f.line : ""}`);
        if (f.description) lines.push(`    ${dim(f.description)}`);
      }
    } else {
      lines.push("findings: none");
    }

    return lines.join("\n");
  });

  const skill = engine.getSkill(skillId);

  if (skill.state === SKILL_STATE.SECURITY_FINDINGS) {
    out.error("Skill scan found security findings. Skill cannot be approved until findings are resolved.");
    return 1;
  }

  return 0;
}

defineCommand("skill-scan", {
  summary: "Scan a skill source with SkillSpector before activation",
  valueFlags: [],
  run,
});

export default { run };
