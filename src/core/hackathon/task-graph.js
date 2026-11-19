// Task contract graph for Hackathon Mode.
//
// Versioned task contracts with dependency tracking. When a contract changes,
// a new version is created and affected workers are notified. Previous
// decisions are preserved.



/** A task contract: the authoritative description of one unit of work. */
export class TaskContract {
  constructor({
    taskId,
    version = 1,
    title,
    objective,
    assignedWorkerId = null,
    requiredCapabilities = [],
    inputs = {},
    expectedOutputs = {},
    filesOwned = [],
    dependencies = [],
    interfaceContracts = [],
    acceptanceCriteria = [],
    requiredTests = [],
    securityRestrictions = [],
    priority = "medium",
    retryPolicy = { maxRetries: 3, backoffMs: 5000 },
    state = "pending",
    progress = 0,
    evidence = [],
    leaseId = null,
    createdAt = null,
    updatedAt = null,
  } = {}) {
    this.taskId = taskId;
    this.version = version;
    this.title = title;
    this.objective = objective;
    this.assignedWorkerId = assignedWorkerId;
    this.requiredCapabilities = requiredCapabilities;
    this.inputs = inputs;
    this.expectedOutputs = expectedOutputs;
    this.filesOwned = filesOwned;
    this.dependencies = dependencies;
    this.interfaceContracts = interfaceContracts;
    this.acceptanceCriteria = acceptanceCriteria;
    this.requiredTests = requiredTests;
    this.securityRestrictions = securityRestrictions;
    this.priority = priority;
    this.retryPolicy = retryPolicy;
    this.state = state;
    this.progress = progress;
    this.evidence = evidence;
    this.leaseId = leaseId;
    this.createdAt = createdAt || new Date().toISOString();
    this.updatedAt = updatedAt || this.createdAt;
  }

  toJSON() {
    return {
      taskId: this.taskId,
      version: this.version,
      title: this.title,
      objective: this.objective,
      assignedWorkerId: this.assignedWorkerId,
      requiredCapabilities: this.requiredCapabilities,
      inputs: this.inputs,
      expectedOutputs: this.expectedOutputs,
      filesOwned: this.filesOwned,
      dependencies: this.dependencies,
      interfaceContracts: this.interfaceContracts,
      acceptanceCriteria: this.acceptanceCriteria,
      requiredTests: this.requiredTests,
      securityRestrictions: this.securityRestrictions,
      priority: this.priority,
      retryPolicy: this.retryPolicy,
      state: this.state,
      progress: this.progress,
      evidence: this.evidence,
      leaseId: this.leaseId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(json) {
    return new TaskContract(json);
  }
}

/**
 * TaskGraph manages versioned task contracts and their dependency graph.
 *
 * Contract versioning: when a contract changes, increment the version and
 * record the previous version. Affected workers are identified via
 * filesOwned and dependencies.
 */
export class TaskGraph {
  constructor() {
    this.contracts = new Map(); // taskId -> TaskContract (latest)
    this.versions = new Map(); // taskId -> TaskContract[] (history)
    this.dependents = new Map(); // taskId -> Set<taskId> (tasks that depend on this)
  }

  /** Add or update a contract. Returns the contract. */
  upsert(contract) {
    if (!(contract instanceof TaskContract)) {
      contract = TaskContract.fromJSON(contract);
    }

    const existing = this.contracts.get(contract.taskId);
    if (existing) {
      // Preserve history: increment version, archive previous.
      const newVersion = existing.version + 1;
      contract.version = newVersion;
      contract.updatedAt = new Date().toISOString();
      const history = this.versions.get(contract.taskId) || [];
      history.push(existing);
      this.versions.set(contract.taskId, history);
    } else {
      contract.createdAt = contract.createdAt || new Date().toISOString();
      contract.updatedAt = contract.updatedAt || contract.createdAt;
    }

    this.contracts.set(contract.taskId, contract);
    this._rebuildDependents();
    return contract;
  }

  /** Get the latest contract for a task. */
  get(taskId) {
    return this.contracts.get(taskId);
  }

  /** Get version history for a task. */
  history(taskId) {
    return (this.versions.get(taskId) || []).slice();
  }

  /** Remove a contract and its dependencies. */
  remove(taskId) {
    this.contracts.delete(taskId);
    this.versions.delete(taskId);
    this.dependents.delete(taskId);
    // Remove this task from other tasks' dependent sets.
    for (const [_, set] of this.dependents) {
      set.delete(taskId);
    }
  }

  /** List task IDs with no unsatisfied dependencies (ready to schedule). */
  ready(taskStates = {}) {
    const ready = [];
    for (const [taskId, contract] of this.contracts) {
      if (contract.state !== "pending" && contract.state !== "assigned") continue;
      const deps = contract.dependencies || [];
      const allDone = deps.every((d) => taskStates[d] === "completed");
      if (allDone) ready.push(taskId);
    }
    return ready;
  }

  /** Get tasks that depend on `taskId` (affected when this task changes). */
  dependentsOf(taskId) {
    return [...(this.dependents.get(taskId) || [])];
  }

  /** Detect cycles in the dependency graph. Returns the cycle path or null. */
  detectCycle() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of this.contracts.keys()) color.set(id, WHITE);

    const dfs = (id, path) => {
      color.set(id, GRAY);
      const contract = this.contracts.get(id);
      for (const dep of contract.dependencies || []) {
        const c = color.get(dep);
        if (c === GRAY) return [...path, id, dep];
        if (c === WHITE) {
          const found = dfs(dep, [...path, id]);
          if (found) return found;
        }
      }
      color.set(id, BLACK);
      return null;
    };

    for (const id of this.contracts.keys()) {
      if (color.get(id) === WHITE) {
        const found = dfs(id, []);
        if (found) return found;
      }
    }
    return null;
  }

  /** Find affected workers for a contract change: owners + dependents' owners. */
  affectedWorkers(taskId) {
    const workers = new Set();
    const contract = this.contracts.get(taskId);
    if (contract) {
      if (contract.assignedWorkerId) workers.add(contract.assignedWorkerId);
      for (const depId of this.dependentsOf(taskId)) {
        const dep = this.contracts.get(depId);
        if (dep && dep.assignedWorkerId) workers.add(dep.assignedWorkerId);
      }
    }
    return [...workers];
  }

  _rebuildDependents() {
    this.dependents.clear();
    for (const [taskId, contract] of this.contracts) {
      for (const dep of contract.dependencies || []) {
        if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
        this.dependents.get(dep).add(taskId);
      }
    }
  }
}

export default { TaskContract, TaskGraph };
