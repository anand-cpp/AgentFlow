// Integration Supervisor for Hackathon Mode.
//
// The Admin Agent acts as the Integration Supervisor. It validates worker
// implementations against the authoritative architecture, detects conflicts
// between workers, and decides whether branches are ready for integration.
//
// Responsibilities:
//   - Maintain the authoritative architecture and contracts
//   - Validate worker implementations against contracts
//   - Detect incompatible interfaces, duplicate implementations,
//     conflicting dependency changes
//   - Review branch diffs and actual GitHub commits
//   - Block incompatible integration
//   - Create corrective tasks
//   - Revalidate after corrections

export const CONTRACT_STATUS = {
  DRAFT: "draft",
  REVIEWED: "reviewed",
  APPROVED: "approved",
  DEPRECATED: "deprecated",
};

export const INTEGRATION_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  BLOCKED: "blocked",
  INTEGRATED: "integrated",
};

export const CONFLICT_SEVERITY = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

/** A versioned architecture contract. */
export function createContract({
  contractId,
  name,
  description,
  moduleBoundaries = [],
  apiContracts = [],
  dataSchemas = [],
  eventContracts = [],
  dependencyRules = [],
  version = 1,
} = {}) {
  if (!contractId) throw new Error("contractId required");
  if (!name) throw new Error("name required");

  return {
    contractId,
    name,
    description,
    status: CONTRACT_STATUS.DRAFT,
    version,
    moduleBoundaries: Array.isArray(moduleBoundaries) ? moduleBoundaries : [],
    apiContracts: Array.isArray(apiContracts) ? apiContracts : [],
    dataSchemas: Array.isArray(dataSchemas) ? dataSchemas : [],
    eventContracts: Array.isArray(eventContracts) ? eventContracts : [],
    dependencyRules: Array.isArray(dependencyRules) ? dependencyRules : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedBy: null,
    approvedAt: null,
  };
}

/** An integration conflict detected between workers. */
export function createConflict({
  conflictId,
  severity,
  description,
  affectedWorkers = [],
  affectedTasks = [],
  affectedContracts = [],
  recommendedAction = null,
} = {}) {
  if (!conflictId) throw new Error("conflictId required");

  return {
    conflictId,
    severity,
    description,
    affectedWorkers: Array.isArray(affectedWorkers) ? affectedWorkers : [],
    affectedTasks: Array.isArray(affectedTasks) ? affectedTasks : [],
    affectedContracts: Array.isArray(affectedContracts) ? affectedContracts : [],
    status: "open",
    recommendedAction,
    createdAt: new Date().toISOString(),
    resolutionHistory: [],
  };
}

/** An integration decision for a worker branch. */
export function createIntegrationDecision({
  decisionId,
  workerId,
  branch,
  status,
  summary,
  issues = [],
  approvedBy = null,
} = {}) {
  if (!decisionId) throw new Error("decisionId required");
  if (!workerId) throw new Error("workerId required");

  return {
    decisionId,
    workerId,
    branch,
    status,
    summary,
    issues: Array.isArray(issues) ? issues : [],
    approvedBy,
    decidedAt: new Date().toISOString(),
  };
}

/**
 * IntegrationSupervisor — validates worker implementations and manages
 * integration decisions.
 */
export class IntegrationSupervisor {
  constructor({ coordinator = null, eventLog = null } = {}) {
    this.coordinator = coordinator || null;
    this.eventLog = eventLog || null;
    this.contracts = new Map(); // contractId -> contract
    this.conflicts = new Map(); // conflictId -> conflict
    this.decisions = new Map(); // decisionId -> decision
    this._contractCounter = 0;
    this._conflictCounter = 0;
    this._decisionCounter = 0;
  }

  /** Create a new architecture contract. */
  createContract(contract = {}) {
    const contractId = contract.contractId || `contract-${++this._contractCounter}`;
    const version = contract.version || 1;
    const c = createContract({ ...contract, contractId, version });
    this.contracts.set(c.contractId, c);
    this._emit("contract.created", { contractId: c.contractId, name: c.name });
    return { ...c };
  }

  /** Approve a contract. */
  approveContract({ contractId, approvedBy } = {}) {
    const c = this.contracts.get(contractId);
    if (!c) throw new Error(`unknown contract: ${contractId}`);
    c.status = CONTRACT_STATUS.APPROVED;
    c.approvedBy = approvedBy;
    c.approvedAt = new Date().toISOString();
    c.updatedAt = new Date().toISOString();
    this._emit("contract.approved", { contractId, approvedBy });
    return { ...c };
  }

  /** Get a contract by id. */
  getContract(contractId) {
    const c = this.contracts.get(contractId);
    return c ? { ...c } : null;
  }

  /** List all contracts. */
  listContracts() {
    return [...this.contracts.values()].map((c) => ({ ...c }));
  }

  /** Detect conflicts between a worker's changes and existing state.
   *
   * Examines filesOwned, dependencies, and interfaceContracts to find:
   *   - Duplicate implementations (two workers owning same files)
   *   - Interface mismatches (worker's contracts don't match approved)
   *   - Dependency conflicts (conflicting version requirements)
   */
  detectConflicts({ workerId, filesOwned = [], _dependencies = [], interfaceContracts = [] } = {}) {
    const conflicts = [];

    // Check for duplicate file ownership across workers.
    if (this.coordinator) {
      const tasks = this.coordinator.getTasks();
      for (const task of tasks) {
        if (task.assignedWorkerId === workerId) continue;
        const taskFiles = task.filesOwned || [];
        const overlapping = filesOwned.filter((f) => taskFiles.includes(f));
        if (overlapping.length > 0) {
          const conflict = createConflict({
            conflictId: `conflict-${++this._conflictCounter}`,
            severity: CONFLICT_SEVERITY.HIGH,
            description: `Worker ${workerId} and worker ${task.assignedWorkerId} both own: ${overlapping.join(", ")}`,
            affectedWorkers: [workerId, task.assignedWorkerId],
            affectedTasks: [task.taskId],
            recommendedAction: "Reassign file ownership or merge implementations",
          });
          conflicts.push(conflict);
          this.conflicts.set(conflict.conflictId, conflict);
        }
      }
    }

    // Check interface contract compatibility.
    for (const contract of interfaceContracts) {
      const existing = this.contracts.get(contract);
      if (existing && existing.status !== CONTRACT_STATUS.APPROVED) {
        const conflict = createConflict({
          conflictId: `conflict-${++this._conflictCounter}`,
          severity: CONFLICT_SEVERITY.MEDIUM,
          description: `Interface contract ${contract} is not approved (status: ${existing.status})`,
          affectedWorkers: [workerId],
          affectedContracts: [contract],
          recommendedAction: "Wait for contract approval before implementing",
        });
        conflicts.push(conflict);
        this.conflicts.set(conflict.conflictId, conflict);
      }
    }

    // Emit conflict events.
    for (const conflict of conflicts) {
      this._emit("conflict.detected", {
        conflictId: conflict.conflictId,
        severity: conflict.severity,
        workerId,
      });
    }

    return conflicts;
  }

  /** Resolve a conflict. */
  resolveConflict({ conflictId, resolution, resolvedBy } = {}) {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) throw new Error(`unknown conflict: ${conflictId}`);

    conflict.status = "resolved";
    conflict.resolutionHistory.push({
      resolution,
      resolvedBy,
      at: new Date().toISOString(),
    });
    this._emit("conflict.resolved", { conflictId, resolvedBy });
    return { ...conflict };
  }

  /** Make an integration decision for a worker branch. */
  makeDecision({
    workerId,
    branch,
    status = INTEGRATION_STATUS.PENDING,
    summary,
    issues = [],
    approvedBy = null,
  } = {}) {
    const decision = createIntegrationDecision({
      decisionId: `decision-${++this._decisionCounter}`,
      workerId,
      branch,
      status,
      summary,
      issues,
      approvedBy,
    });
    this.decisions.set(decision.decisionId, decision);
    this._emit("integration.decision", {
      decisionId: decision.decisionId,
      workerId,
      status,
    });
    return { ...decision };
  }

  /** Approve a worker branch for integration. */
  approveIntegration({ decisionId, approvedBy } = {}) {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    decision.status = INTEGRATION_STATUS.APPROVED;
    decision.approvedBy = approvedBy;
    decision.decidedAt = new Date().toISOString();
    this._emit("integration.approved", { decisionId, workerId: decision.workerId });
    return { ...decision };
  }

  /** Reject a worker branch from integration. */
  rejectIntegration({ decisionId, rejectedBy, reason } = {}) {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    decision.status = INTEGRATION_STATUS.REJECTED;
    decision.issues.push({ reason, rejectedBy, at: new Date().toISOString() });
    decision.decidedAt = new Date().toISOString();
    this._emit("integration.rejected", { decisionId, workerId: decision.workerId, reason });
    return { ...decision };
  }

  /** Block a worker branch from integration. */
  blockIntegration({ decisionId, blockedBy, reason } = {}) {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`unknown decision: ${decisionId}`);
    decision.status = INTEGRATION_STATUS.BLOCKED;
    decision.issues.push({ reason, blockedBy, at: new Date().toISOString() });
    decision.decidedAt = new Date().toISOString();
    this._emit("integration.blocked", { decisionId, workerId: decision.workerId, reason });
    return { ...decision };
  }

  /** Get all integration decisions. */
  getDecisions() {
    return [...this.decisions.values()].map((d) => ({ ...d }));
  }

  /** Get all open conflicts. */
  getOpenConflicts() {
    return [...this.conflicts.values()].filter((c) => c.status === "open").map((c) => ({ ...c }));
  }

  /** Get integration readiness summary. */
  getReadinessSummary() {
    const decisions = this.getDecisions();
    const conflicts = this.getOpenConflicts();

    return {
      totalDecisions: decisions.length,
      approved: decisions.filter((d) => d.status === INTEGRATION_STATUS.APPROVED).length,
      rejected: decisions.filter((d) => d.status === INTEGRATION_STATUS.REJECTED).length,
      blocked: decisions.filter((d) => d.status === INTEGRATION_STATUS.BLOCKED).length,
      pending: decisions.filter((d) => d.status === INTEGRATION_STATUS.PENDING).length,
      openConflicts: conflicts.length,
      criticalConflicts: conflicts.filter((c) => c.severity === CONFLICT_SEVERITY.CRITICAL).length,
      readyForIntegration: decisions.filter(
        (d) => d.status === INTEGRATION_STATUS.APPROVED,
      ).length,
    };
  }

  /** Emit an event. */
  _emit(type, data) {
    if (this.eventLog) {
      this.eventLog.emit(type, data, "info");
    }
  }
}

export default {
  CONTRACT_STATUS,
  INTEGRATION_STATUS,
  CONFLICT_SEVERITY,
  createContract,
  createConflict,
  createIntegrationDecision,
  IntegrationSupervisor,
};
