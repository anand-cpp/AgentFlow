// `aflow publish` — distribution readiness, and deliberately nothing else.
//
// This command answers one question before a release: would the package
// actually publish, and would what ships be what we mean to ship? It checks the
// fields npm reads, the file the bins point at, the version agreement, the
// dependency floor, and that the working tree carries no credentials. It never
// publishes; publishing is a tag push that CI turns into an npm upload.
//
// The split is intentional. `npm publish` is irreversible once the registry
// accepts it, so the failure modes that matter -- a missing file in the
// whitelist, a version that only bumped in one place, a leaked key -- are
// exactly the ones that are cheap to catch here and expensive to catch there.
//
// Run it from the package root. The readiness checks are about the current
// checkout, so they resolve package.json from the working directory.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "../cli/registry.js";
import { VERSION } from "../core/version.js";
import { bold, dim, heading, table, symbol, statusColor, green, red, yellow } from "../cli/ui.js";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function readPackageJson(cwd) {
  try {
    return { pkg: JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")), error: null };
  } catch (err) {
    return { pkg: null, error: err?.message || String(err) };
  }
}

/**
 * Are we running from a Single Executable Application?
 *
 * node:sea landed in Node 20.12, so the import is dynamic and guarded; on older
 * runtimes the honest answer is "no". Cached because publish only asks once.
 */
let seaChecked = false;
let runningAsSea = false;
async function isSea() {
  if (seaChecked) return runningAsSea;
  seaChecked = true;
  try {
    const sea = await import("node:sea");
    runningAsSea = typeof sea.isSea === "function" && sea.isSea();
  } catch {
    runningAsSea = false;
  }
  return runningAsSea;
}

/**
 * Run the committed-credential scanner over the working tree.
 *
 * A false positive here blocks a publish, which is the correct failure, but it
 * is also the check most likely to be unavailable in an installed copy (scripts/
 * is not shipped). Absent means "skipped", never "clean".
 *
 * Under SEA the scanner cannot run at all: process.execPath is the packaged
 * binary, so spawning it with a script path re-invokes the CLI instead of node.
 * Reporting a credential hit there would be a lie, so it is skipped instead.
 */
function scanForSecrets(cwd, canScan) {
  if (!canScan) return { skipped: true, reason: "binary" };
  const script = path.join(cwd, "scripts", "scan-secrets.mjs");
  if (!fs.existsSync(script)) return { skipped: true, reason: "source" };
  try {
    execFileSync(process.execPath, [script], { cwd, encoding: "utf8" });
    return { skipped: false, clean: true };
  } catch {
    return { skipped: false, clean: false };
  }
}

/** Is this checkout logged in to npm? Only run on request -- it needs a token. */
function checkNpmAuth() {
  try {
    const who = execSync("npm whoami", { encoding: "utf8" }).trim();
    return { ok: true, who };
  } catch {
    return { ok: false };
  }
}

/**
 * The static readiness checks. Each returns { name, status, detail }, where
 * status is the same vocabulary the other checks use: ok, error, unconfigured,
 * or a skipped pseudo-status for checks that could not run.
 */
function collectChecks(pkg, cwd, flags, canScan) {
  /** @type {{ name: string, status: string, detail: string }[]} */
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  if (!pkg) {
    add("package.json", "error", "unreadable or not valid JSON");
    return checks;
  }
  add("package.json", "ok", `${pkg.name}@${pkg.version}`);

  add(
    "name",
    pkg.name === "agentflow-cli" ? "ok" : "error",
    pkg.name === "agentflow-cli" ? "agentflow-cli" : `expected agentflow-cli, got ${pkg.name}`
  );

  add("version", SEMVER.test(pkg.version) ? "ok" : "error", pkg.version);
  add(
    "version-sync",
    pkg.version === VERSION ? "ok" : "error",
    pkg.version === VERSION
      ? `package.json and src/core/version.js agree on ${VERSION}`
      : `package.json=${pkg.version} but src/core/version.js=${VERSION}`
  );
  add("type", pkg.type === "module" ? "ok" : "error", pkg.type);

  const binEntry = pkg.bin?.agentflow || pkg.bin?.aflow || null;
  add("bin", binEntry === "./bin/agentflow.js" ? "ok" : "error", binEntry || "no bin entry");
  const binFile = binEntry ? path.join(cwd, binEntry.replace(/^\.\//, "")) : null;
  const binExists = binFile ? fs.existsSync(binFile) : false;
  let shebang = false;
  if (binExists) {
    const first = fs.readFileSync(binFile, "utf8").split("\n")[0];
    shebang = first === "#!/usr/bin/env node";
  }
  add(
    "bin file",
    binExists && shebang ? "ok" : "error",
    binExists ? (shebang ? "exists with node shebang" : "missing #!/usr/bin/env node shebang") : "missing"
  );

  // The whitelist is what actually decides the tarball; a path listed here that
  // is missing on disk ships a broken package even if the rest is perfect.
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const missing = files.filter((rel) => !fs.existsSync(path.join(cwd, rel)));
  add(
    "files whitelist",
    files.length && !missing.length ? "ok" : "error",
    missing.length ? `missing: ${missing.join(", ")}` : `${files.length} path(s) present`
  );

  const deps = Object.keys(pkg.dependencies || {});
  add("dependencies", deps.length === 0 ? "ok" : "error", deps.length ? `unexpected: ${deps.join(", ")}` : "0 runtime deps");

  const floor = String(pkg.engines?.node || "");
  const major = Number((floor.match(/\d+/) || [0])[0]);
  add("engines.node", major >= 20 ? "ok" : "error", floor || "unset");

  const exportTarget = pkg.exports?.["."] || null;
  add(
    "exports",
    exportTarget && fs.existsSync(path.join(cwd, exportTarget)) ? "ok" : "error",
    exportTarget || "no exports map"
  );

  add("license", pkg.license ? "ok" : "error", pkg.license || "unset");
  add(
    ".npmignore",
    fs.existsSync(path.join(cwd, ".npmignore")) ? "ok" : "error",
    "secrets and dev trees excluded"
  );

  const secrets = scanForSecrets(cwd, canScan);
  const secretDetail = secrets.skipped
    ? secrets.reason === "binary"
      ? "binary cannot run the source scanner — check from a checkout"
      : "scripts/ not present — run npm run scan-secrets"
    : secrets.clean
      ? "working tree clean"
      : "potential credential(s) found";
  add(
    "secrets",
    secrets.skipped ? "unconfigured" : secrets.clean ? "ok" : "error",
    secretDetail
  );

  // Auth needs a network call and a token, so it is opt-in: `aflow publish
  // --auth`. Everything above is deterministic and offline.
  if (flags.auth) {
    const auth = checkNpmAuth();
    add("npm auth", auth.ok ? "ok" : "error", auth.ok ? `logged in as ${auth.who}` : "not logged in (npm whoami failed)");
  }

  return checks;
}

async function runPublish({ cwd, out, flags }) {
  const { pkg } = readPackageJson(cwd);
  const canScan = !(await isSea());
  const checks = collectChecks(pkg, cwd, flags, canScan);

  await out.init({ checks, version: VERSION }, (r) => {
    const lines = [];
    lines.push(heading(bold("aflow publish")));
    lines.push(dim("distribution readiness — this command never publishes"));
    lines.push("");
    lines.push(
      table(
        r.checks.map((c) => ({ check: c.name, status: statusColor(c.status), detail: c.detail })),
        [
          { key: "check", label: "CHECK" },
          { key: "status", label: "STATUS" },
          { key: "detail", label: "DETAIL", max: 68 },
        ]
      )
    );

    const errors = r.checks.filter((c) => c.status === "error").length;
    const skipped = r.checks.filter((c) => c.status === "unconfigured").length;
    lines.push("");
    if (errors) {
      lines.push(red(`${symbol("fail")} ${errors} check(s) would fail the publish`));
    } else if (skipped) {
      lines.push(yellow(`${symbol("warn")} ${skipped} check(s) skipped — run from a source checkout to scan for credentials`));
    } else {
      lines.push(green(`${symbol("ok")} ready to publish (cut a tag and let CI do it)`));
    }
    return lines.join("\n");
  });

  const errors = checks.filter((c) => c.status === "error").length;
  return errors ? 1 : 0;
}

export const publishCommand = defineCommand("publish", {
  summary: "check distribution readiness before an npm publish (never publishes)",
  usage: `aflow publish [--auth] [--json]

Verifies the package would publish cleanly: the fields npm reads, the file the
bins point at, the version agreement, a dependency-free runtime, and that the
working tree carries no credentials.

With --auth it additionally confirms you are logged in to npm (needs a token).

This command never publishes. Releases are cut by tag; see scripts/release.mjs.`,
  run: ({ out, flags }) => runPublish({ cwd: process.cwd(), out, flags }),
});

export default publishCommand;
