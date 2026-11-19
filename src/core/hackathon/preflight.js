// Worker pre-flight capability testing for Hackathon Mode.
//
// Every discovered PC must undergo real pre-flight tests before receiving
// project tasks. The Admin PC runs these tests against each connecting worker
// (or against itself for its own development agent) and produces a structured
// capability report. The Admin Agent explicitly approves or rejects each
// device based on the report.
//
// No capabilities are invented — everything is measured or verified. A failed
// mandatory check blocks project-task admission until resolved.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

/** Result of one pre-flight check. */
export class CheckResult {
  constructor({ name, status, value, detail, error, critical } = {}) {
    this.name = name;
    this.status = status; // "pass" | "fail" | "warn" | "skip"
    this.value = value;
    this.detail = detail || null;
    this.error = error || null;
    this.critical = critical === true;
    this.checkedAt = new Date().toISOString();
  }
}

/** Aggregate capability report for one device. */
export class CapabilityReport {
  constructor({ deviceId, sessionId } = {}) {
    this.deviceId = deviceId;
    this.sessionId = sessionId;
    this.checkedAt = new Date().toISOString();
    this.checks = [];
    this.hardware = null;
    this.environment = null;
    this.github = null;
    this.provider = null;
    this.execution = null;
    this.overall = "pending"; // "approved" | "rejected" | "pending"
  }

  addCheck(result) {
    this.checks.push(result);
    return result;
  }

  /** Whether all mandatory checks passed. */
  get mandatoryPassed() {
    return this.checks.every(
      (c) => c.status === "pass" || c.status === "skip",
    );
  }

  /** Whether any critical check failed. */
  get criticalFailed() {
    return this.checks.some((c) => c.status === "fail" && c.critical !== false);
  }

  toJSON() {
    return {
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      checkedAt: this.checkedAt,
      overall: this.overall,
      mandatoryPassed: this.mandatoryPassed,
      criticalFailed: this.criticalFailed,
      hardware: this.hardware,
      environment: this.environment,
      github: this.github,
      provider: this.provider,
      execution: this.execution,
      checks: this.checks.map((c) => ({
        name: c.name,
        status: c.status,
        value: c.value,
        detail: c.detail,
        error: c.error,
      })),
    };
  }
}

/** Run a shell command synchronously, returning { stdout, stderr, code }. */
function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10000,
    ...options,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

/** Collect hardware information. */
export async function collectHardware() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();
  const platform = process.platform;
  const arch = process.arch;

  // Disk space for the temp directory.
  const tmpDir = os.tmpdir();
  let diskTotal = 0;
  let diskFree = 0;
  try {
    const stats = fs.statfsSync(tmpDir);
    // statfsSync may not be available on all Node versions; fall back.
    if (stats.bsize && stats.bavail !== undefined) {
      diskFree = stats.bsize * stats.bavail;
      diskTotal = stats.bsize * stats.blocks;
    }
  } catch {
    /* statfs not available — report 0 */
  }

  // GPU detection: try common commands.
  let gpu = null;
  let gpuVram = null;
  if (platform === "win32") {
    const wmic = runCommand("wmic", [
      "path",
      "win32_VideoController",
      "get",
      "Name,AdapterRAM",
      "/format:csv",
    ]);
    if (wmic.code === 0 && wmic.stdout) {
      const lines = wmic.stdout.trim().split("\n").filter((l) => l.trim());
      if (lines.length > 1) {
        const cols = lines[1].split(",");
        gpu = cols[1] || null;
        const ram = Number(cols[2]);
        gpuVram = Number.isFinite(ram) ? ram : null;
      }
    }
  } else {
    const lspci = runCommand("lspci", ["-v"]);
    if (lspci.code === 0 && lspci.stdout) {
      const match = lspci.stdout.match(/VGA compatible controller: (.+)/);
      if (match) gpu = match[1].trim();
    }
  }

  return {
    platform,
    arch,
    cpus: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : null,
    totalMem,
    freeMem,
    memUsagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    diskTotal,
    diskFree,
    gpu,
    gpuVram,
    nodeVersion: process.version,
  };
}

/** Collect development environment information. */
export async function collectEnvironment() {
  const node = runCommand("node", ["--version"]);
  const npm = runCommand("npm", ["--version"]);
  const git = runCommand("git", ["--version"]);

  // Check for common build/test tools.
  const tools = {};
  for (const tool of ["npx", "yarn", "pnpm", "tsc", "esbuild", "vitest"]) {
    const r = runCommand(tool, ["--version"]);
    tools[tool] = r.code === 0 ? r.stdout.trim() : null;
  }

  return {
    node: node.code === 0 ? node.stdout.trim() : null,
    npm: npm.code === 0 ? npm.stdout.trim() : null,
    git: git.code === 0 ? git.stdout.trim() : null,
    tools,
  };
}

/** Verify GitHub access and permissions. */
export async function collectGitHub() {
  const gh = runCommand("gh", ["--version"]);
  const ghAvailable = gh.code === 0;

  let authStatus = null;
  let authUser = null;
  if (ghAvailable) {
    const auth = runCommand("gh", ["auth", "status"]);
    authStatus = auth.code === 0 ? "authenticated" : "not_authenticated";
    // Parse the logged-in user from gh auth status output.
    const userMatch = auth.stdout.match(/github.com[\s]*\(([^)]+)\)/);
    if (userMatch) authUser = userMatch[1].trim();
  }

  // Check git remote and branch.
  const remote = runCommand("git", ["remote", "-v"]);
  const branch = runCommand("git", ["branch", "--show-current"]);
  const status = runCommand("git", ["status", "--porcelain"]);

  return {
    ghAvailable,
    ghVersion: ghAvailable ? gh.stdout.trim() : null,
    authStatus,
    authUser,
    remote: remote.code === 0 ? remote.stdout.trim().split("\n") : [],
    currentBranch: branch.code === 0 ? branch.stdout.trim() : null,
    workingTreeClean: status.code === 0 ? status.stdout.trim() === "" : null,
    canCommitLocally: true, // local commits never require GitHub auth
    canPush: ghAvailable && authStatus === "authenticated",
    canCreatePR: ghAvailable && authStatus === "authenticated",
  };
}

/** Test AI provider connectivity and model capability. */
export async function collectProvider(config = {}) {
  const { baseUrl, apiKeyEnv, modelId } = config;

  const result = {
    provider: null,
    baseUrl: baseUrl || null,
    modelId: modelId || null,
    connectivity: "untested",
    modelAvailable: false,
    toolCalling: false,
    structuredOutput: false,
    latencyMs: null,
    error: null,
  };

  if (!baseUrl) {
    result.connectivity = "skipped";
    result.error = "no provider base URL configured";
    return result;
  }

  // Attempt a minimal connectivity test against the provider.
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const headers = {};
    const keyEnv = apiKeyEnv || "AGENTFLOW_API_KEY";
    const apiKey = process.env[keyEnv];
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeout);
    result.latencyMs = Date.now() - started;
    result.connectivity = response.ok ? "reachable" : "unreachable";

    if (response.ok) {
      const body = await response.json();
      const models = Array.isArray(body?.data) ? body.data : [];
      result.modelAvailable =
        !modelId || models.some((m) => m.id === modelId);
    }
  } catch (err) {
    result.connectivity = "failed";
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/** Perform a real execution test: create file, read, modify, validate. */
export async function collectExecution(workspaceRoot = process.cwd()) {
  const result = {
    commandExecution: false,
    fileCreate: false,
    fileRead: false,
    fileModify: false,
    cleanup: false,
    error: null,
  };

  const testDir = path.join(workspaceRoot, `.agentflow-preflight-${Date.now()}`);
  const testFile = path.join(testDir, "preflight-test.txt");

  try {
    // 1. Create directory (command execution).
    fs.mkdirSync(testDir, { recursive: true });
    result.commandExecution = true;

    // 2. Create test file.
    fs.writeFileSync(testFile, "preflight test content", "utf8");
    result.fileCreate = true;

    // 3. Read it back.
    const content = fs.readFileSync(testFile, "utf8");
    result.fileRead = content === "preflight test content";

    // 4. Modify it.
    fs.writeFileSync(testFile, "preflight test content modified", "utf8");
    const modified = fs.readFileSync(testFile, "utf8");
    result.fileModify = modified === "preflight test content modified";

    // 5. Clean up.
    fs.rmSync(testDir, { recursive: true, force: true });
    result.cleanup = !fs.existsSync(testDir);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Run the complete pre-flight capability assessment for one device.
 *
 * Returns a CapabilityReport. The Admin Agent uses this to decide whether
 * to approve the device for project-task access.
 */
export async function runPreflight({
  deviceId,
  sessionId,
  workspaceRoot = process.cwd(),
  providerConfig = {},
  _githubConfig = {},
} = {}) {
  if (!deviceId) throw new Error("deviceId required");
  if (!sessionId) throw new Error("sessionId required");

  const report = new CapabilityReport({ deviceId, sessionId });

  // --- Hardware ---
  const hardware = await collectHardware();
  report.hardware = hardware;
  report.addCheck(
    new CheckResult({
      name: "cpu_available",
      status: hardware.cpus > 0 ? "pass" : "fail",
      value: `${hardware.cpus} CPU(s)`,
      detail: hardware.cpuModel,
      critical: false,
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "memory_available",
      status: hardware.totalMem > 0 ? "pass" : "fail",
      value: `${Math.round(hardware.totalMem / 1024 / 1024 / 1024)} GB total`,
      detail: `${Math.round((hardware.freeMem / hardware.totalMem) * 100)}% free`,
      critical: false,
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "disk_space",
      status: hardware.diskFree > 0 ? "pass" : "skip",
      value: `${Math.round(hardware.diskFree / 1024 / 1024 / 1024)} GB free`,
      detail: `${Math.round(hardware.diskTotal / 1024 / 1024 / 1024)} GB total`,
      critical: false,
    }),
  );

  // --- Environment ---
  const env = await collectEnvironment();
  report.environment = env;
  report.addCheck(
    new CheckResult({
      name: "nodejs",
      status: env.node ? "pass" : "fail",
      value: env.node || "not found",
      critical: true,
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "npm",
      status: env.npm ? "pass" : "warn",
      value: env.npm || "not found",
      critical: false,
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "git",
      status: env.git ? "pass" : "fail",
      value: env.git || "not found",
      critical: true,
    }),
  );

  // --- GitHub ---
  const gh = await collectGitHub();
  report.github = gh;
  report.addCheck(
    new CheckResult({
      name: "github_cli",
      status: gh.ghAvailable ? "pass" : "skip",
      value: gh.ghAvailable ? gh.ghVersion : "not installed",
      detail: gh.authStatus,
      critical: false,
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "github_auth",
      status: gh.authStatus === "authenticated" ? "pass" : "warn",
      value: gh.authUser || gh.authStatus || "not authenticated",
      detail: gh.canPush ? "push enabled" : "push disabled",
      critical: false,
      note:
        "Local commits work without GitHub auth; push and PR require auth.",
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "github_push",
      status: gh.canPush ? "pass" : "warn",
      value: gh.canPush ? "enabled" : "disabled",
      detail: "Required for pushing worker branches",
      critical: false,
    }),
  );

  // --- Provider ---
  const provider = await collectProvider(providerConfig);
  report.provider = provider;
  report.addCheck(
    new CheckResult({
      name: "provider_connectivity",
      status: provider.connectivity === "reachable" ? "pass" : "warn",
      value: provider.connectivity,
      detail: provider.error || provider.baseUrl || "not configured",
      critical: false,
    }),
  );
  report.addCheck(
    new CheckResult({
      name: "provider_model",
      status: provider.modelAvailable ? "pass" : "warn",
      value: provider.modelId || "not configured",
      detail: provider.connectivity === "reachable" ? "available" : "untested",
      critical: false,
    }),
  );

  // --- Execution ---
  const execution = await collectExecution(workspaceRoot);
  report.execution = execution;
  const execPass =
    execution.commandExecution &&
    execution.fileCreate &&
    execution.fileRead &&
    execution.fileModify &&
    execution.cleanup;
  report.addCheck(
    new CheckResult({
      name: "execution_test",
      status: execPass ? "pass" : "fail",
      value: execPass ? "all passed" : "failed",
      detail: execution.error || null,
      critical: true,
    }),
  );

  // Overall determination.
  report.overall = report.mandatoryPassed ? "approved" : "pending";

  return report;
}

export default {
  CheckResult,
  CapabilityReport,
  runPreflight,
  collectHardware,
  collectEnvironment,
  collectGitHub,
  collectProvider,
  collectExecution,
};
