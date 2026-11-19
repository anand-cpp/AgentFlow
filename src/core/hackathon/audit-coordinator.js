// Parallel final audit system for Hackathon Mode.
//
// Runs six independent audit streams concurrently with bounded concurrency:
//   1. Security        — authentication, authorization, secrets, vulnerabilities
//   2. Functional      — broken behavior, crashes, state transitions, edge cases
//   3. Architecture    — APIs, schemas, event contracts, dependency compatibility
//   4. Testing         — unit, integration, regression, end-to-end coverage
//   5. Dependency      — package versions, lockfiles, vulnerabilities
//   6. Deployment      — startup, configuration, credentials, restart recovery
//
// Initial auditors are read-only — they collect findings but do not modify
// source files. The Admin Agent deduplicates, verifies, assigns severity,
// creates corrective tasks, and coordinates fixes.

import { EventEmitter } from "node:events";

export const AUDIT_STREAM = {
  SECURITY: "security",
  FUNCTIONAL: "functional",
  ARCHITECTURE: "architecture",
  TESTING: "testing",
  DEPENDENCY: "dependency",
  DEPLOYMENT: "deployment",
};

export const FINDING_SEVERITY = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
};

export const FINDING_STATUS = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  IN_PROGRESS: "in_progress",
  RESOLVED: "resolved",
  FALSE_POSITIVE: "false_positive",
};

/** A single audit finding. */
export function createFinding({
  findingId,
  stream,
  severity,
  title,
  description,
  file = null,
  line = null,
  evidence = null,
  recommendation = null,
} = {}) {
  if (!findingId) throw new Error("findingId required");
  if (!stream) throw new Error("stream required");
  if (!severity) throw new Error("severity required");
  if (!title) throw new Error("title required");
  if (!description) throw new Error("description required");

  return {
    findingId,
    stream,
    severity,
    title,
    description,
    file,
    line,
    evidence: evidence || null,
    recommendation: recommendation || null,
    status: FINDING_STATUS.OPEN,
    detectedAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

/** Result of one audit stream. */
export class AuditStreamResult {
  constructor({ stream, findings = [], durationMs, error } = {}) {
    this.stream = stream;
    this.findings = findings;
    this.durationMs = durationMs;
    this.error = error;
    this.completedAt = new Date().toISOString();
  }

  get findingCount() {
    return this.findings.length;
  }

  get criticalCount() {
    return this.findings.filter((f) => f.severity === FINDING_SEVERITY.CRITICAL).length;
  }

  get highCount() {
    return this.findings.filter((f) => f.severity === FINDING_SEVERITY.HIGH).length;
  }

  toJSON() {
    return {
      stream: this.stream,
      findingCount: this.findingCount,
      criticalCount: this.criticalCount,
      highCount: this.highCount,
      durationMs: this.durationMs,
      error: this.error ? String(this.error) : null,
      completedAt: this.completedAt,
      findings: this.findings.map((f) => ({ ...f })),
    };
  }
}

/**
 * AuditRunner — executes one audit stream.
 *
 * Subclasses implement the `run()` method to perform read-only inspection
 * and return findings. The runner must not modify source files.
 */
export class AuditRunner {
  constructor({ stream, context = {} } = {}) {
    this.stream = stream;
    this.context = context;
  }

  /** Run the audit and return findings. Must be implemented by subclasses. */
  async run() {
    throw new Error(`audit runner ${this.stream} does not implement run()`);
  }
}

/**
 * AuditCoordinator — manages parallel execution of audit streams.
 *
 * Launches independent auditors concurrently with bounded concurrency,
 * collects findings, deduplicates, and provides a unified report.
 */
export class AuditCoordinator {
  constructor({ maxConcurrency = 3, eventLog = null } = {}) {
    this.maxConcurrency = maxConcurrency;
    this.eventLog = eventLog || null;
    this.runners = new Map(); // stream -> AuditRunner
    this._results = new Map(); // stream -> AuditStreamResult
    this._emitter = new EventEmitter();
    this._running = false;
    this._hasRun = false;
  }

  /** Register an audit runner for a stream. */
  registerRunner(stream, runner) {
    if (!(runner instanceof AuditRunner)) {
      throw new Error(`runner for ${stream} must extend AuditRunner`);
    }
    this.runners.set(stream, runner);
    return this;
  }

  /** Get a registered runner. */
  getRunner(stream) {
    return this.runners.get(stream) || null;
  }

  /** Run all registered audit streams concurrently with bounded concurrency. */
  async runAll() {
    if (this._hasRun) {
      throw new Error("audit coordinator already ran; create a new instance to re-run");
    }
    if (this._running) {
      throw new Error("audit coordinator already running");
    }
    this._running = true;
    this._hasRun = true;
    this._results.clear();

    const streams = [...this.runners.keys()];
    const results = await this._runConcurrent(streams);

    this._running = false;
    return results;
  }

  /** Run a subset of audit streams. */
  async runStreams(streams) {
    if (this._hasRun) {
      throw new Error("audit coordinator already ran; create a new instance to re-run");
    }
    if (this._running) {
      throw new Error("audit coordinator already running");
    }
    this._running = true;
    this._hasRun = true;
    this._results.clear();

    const results = await this._runConcurrent(streams);

    this._running = false;
    return results;
  }

  /** Run streams with bounded concurrency. */
  async _runConcurrent(streams) {
    const results = [];

    // Run streams in chunks of maxConcurrency for bounded concurrency.
    for (let i = 0; i < streams.length; i += this.maxConcurrency) {
      const chunk = streams.slice(i, i + this.maxConcurrency);
      const chunkResults = await Promise.all(
        chunk.map((stream) => this._runStream(stream)),
      );
      for (const result of chunkResults) {
        this._results.set(result.stream, result);
        this._emitter.emit("streamComplete", result.stream, result);
        results.push(result);
      }
    }

    return results;
  }

  /** Run one audit stream and return its result. */
  async _runStream(stream) {
    const runner = this.runners.get(stream);
    if (!runner) {
      return new AuditStreamResult({
        stream,
        error: new Error(`no runner registered for stream: ${stream}`),
      });
    }

    const startedAt = Date.now();
    try {
      const findings = await runner.run();
      const durationMs = Date.now() - startedAt;
      const result = new AuditStreamResult({
        stream,
        findings: Array.isArray(findings) ? findings : [],
        durationMs,
      });

      if (this.eventLog) {
        this.eventLog.emit("audit.streamComplete", {
          stream: result.stream,
          findingCount: result.findingCount,
          criticalCount: result.criticalCount,
          durationMs: result.durationMs,
        }, "info");
      }

      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      return new AuditStreamResult({
        stream,
        durationMs,
        error: err,
      });
    }
  }

  /** Get all results. */
  getResults() {
    return new Map(this._results);
  }

  /** Get the result for a specific stream. */
  getResult(stream) {
    return this._results.get(stream) || null;
  }

  /** Whether all runs are complete. */
  isComplete() {
    return !this._running && this._results.size === this.runners.size;
  }

  /** Deduplicate findings across all streams. */
  deduplicateFindings() {
    const seen = new Set();
    const unique = [];
    const duplicates = [];

    for (const [_stream, result] of this._results) {
      for (const finding of result.findings) {
        const key = `${finding.stream}:${finding.title}:${finding.file || ""}:${finding.line || ""}`;
        if (seen.has(key)) {
          duplicates.push({ ...finding, _duplicateOf: key });
        } else {
          seen.add(key);
          unique.push({ ...finding });
        }
      }
    }

    return { unique, duplicates };
  }

  /** Get all findings across all streams. */
  getAllFindings() {
    const all = [];
    for (const result of this._results.values()) {
      all.push(...result.findings);
    }
    return all;
  }

  /** Get critical and high severity findings. */
  getCriticalFindings() {
    return this.getAllFindings().filter(
      (f) => f.severity === FINDING_SEVERITY.CRITICAL || f.severity === FINDING_SEVERITY.HIGH,
    );
  }

  /** Get audit summary. */
  getSummary() {
    const allFindings = this.getAllFindings();
    const streamSummaries = {};
    for (const [_stream, result] of this._results) {
      streamSummaries[_stream] = {
        findingCount: result.findingCount,
        criticalCount: result.criticalCount,
        highCount: result.highCount,
        durationMs: result.durationMs,
        error: result.error ? String(result.error) : null,
      };
    }

    return {
      streamCount: this.runners.size,
      completedStreams: this._results.size,
      totalFindings: allFindings.length,
      criticalFindings: allFindings.filter((f) => f.severity === FINDING_SEVERITY.CRITICAL).length,
      highFindings: allFindings.filter((f) => f.severity === FINDING_SEVERITY.HIGH).length,
      mediumFindings: allFindings.filter((f) => f.severity === FINDING_SEVERITY.MEDIUM).length,
      streamSummaries,
    };
  }

  /** Subscribe to stream completion events. */
  onStreamComplete(listener) {
    this._emitter.on("streamComplete", listener);
    return () => this._emitter.off("streamComplete", listener);
  }
}

export default {
  AUDIT_STREAM,
  FINDING_SEVERITY,
  FINDING_STATUS,
  createFinding,
  AuditStreamResult,
  AuditRunner,
  AuditCoordinator,
};
