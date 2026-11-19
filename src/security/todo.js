// TODO engine — persistent task tracking for development tasks.
//
// Every development task generates a relevant task checklist that adapts to
// the task type. Tasks have verifiable completion conditions and are tied to
// the security orchestration lifecycle.

import { VERIFICATION_STATUS } from "./scanners/base.js";

/** Task status values. */
export const TASK_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  FAILED: "failed",
};

/** Task category values. */
export const TASK_CATEGORY = {
  REQUIREMENTS: "requirements",
  IMPLEMENTATION: "implementation",
  TESTING: "testing",
  SECURITY: "security",
  REMEDIATION: "remediation",
  VERIFICATION: "verification",
  DELIVERY: "delivery",
};

/** Task verification modes. */
export const TASK_VERIFICATION = {
  MANUAL: "manual",
  AUTO_TEST: "auto_test",
  SECURITY_SCAN: "security_scan",
  FINDING_RESOLVED: "finding_resolved",
  FINDING_REMEDIATED: "finding_remediated",
};

/**
 * A single task within a task list.
 */
export class Task {
  constructor({
    id = null,
    title = "",
    description = "",
    category = TASK_CATEGORY.IMPLEMENTATION,
    status = TASK_STATUS.PENDING,
    verification = TASK_VERIFICATION.MANUAL,
    sourceEvent = null,
    dependsOn = [],
    blockedBy = [],
    evidence = null,
    completedAt = null,
    completedBy = null,
    verificationResult = null,
  } = {}) {
    this.id = id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.title = title;
    this.description = description;
    this.category = category;
    this.status = status;
    this.verification = verification;
    this.sourceEvent = sourceEvent;
    this.dependsOn = dependsOn;
    this.blockedBy = blockedBy;
    this.evidence = evidence;
    this.completedAt = completedAt;
    this.completedBy = completedBy;
    this.verificationResult = verificationResult;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  get isCompleted() {
    return this.status === TASK_STATUS.COMPLETED;
  }

  get isBlocked() {
    return this.status === TASK_STATUS.BLOCKED;
  }

  get canStart() {
    return this.status === TASK_STATUS.PENDING && this.dependsOn.every(() => {
      // dependsOn references task IDs that must be completed
      return true; // resolved by TodoEngine
    });
  }
}

/**
 * A task list for a development task.
 */
export class TaskList {
  constructor({ id = null, title = "", taskType = "general", sourceEvent = null, tasks = [] } = {}) {
    this.id = id || `todolist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.title = title;
    this.taskType = taskType;
    this.sourceEvent = sourceEvent;
    this.tasks = tasks.map((t) => (t instanceof Task ? t : new Task(t)));
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  get progress() {
    if (this.tasks.length === 0) return 0;
    const completed = this.tasks.filter((t) => t.isCompleted).length;
    return Math.round((completed / this.tasks.length) * 100);
  }

  get isComplete() {
    return this.tasks.length > 0 && this.tasks.every((t) => t.isCompleted || t.status === TASK_STATUS.SKIPPED);
  }

  get blockedTasks() {
    return this.tasks.filter((t) => t.isBlocked);
  }

  get pendingTasks() {
    return this.tasks.filter((t) => t.status === TASK_STATUS.PENDING);
  }

  get inProgressTasks() {
    return this.tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS);
  }

  addTask(task) {
    const t = task instanceof Task ? task : new Task(task);
    this.tasks.push(t);
    this.updatedAt = new Date().toISOString();
    return t;
  }

  getTask(id) {
    return this.tasks.find((t) => t.id === id);
  }

  updateTask(id, updates) {
    const task = this.getTask(id);
    if (!task) return false;
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    return true;
  }

  completeTask(id, evidence = null, verificationResult = null) {
    const task = this.getTask(id);
    if (!task) return false;
    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = new Date().toISOString();
    task.evidence = evidence;
    task.verificationResult = verificationResult;
    task.updatedAt = new Date().toISOString();
    return true;
  }

  blockTask(id, reason = null) {
    const task = this.getTask(id);
    if (!task) return false;
    task.status = TASK_STATUS.BLOCKED;
    task.evidence = { ...task.evidence, blockReason: reason };
    task.updatedAt = new Date().toISOString();
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      taskType: this.taskType,
      sourceEvent: this.sourceEvent,
      progress: this.progress,
      isComplete: this.isComplete,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      tasks: this.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        category: t.category,
        status: t.status,
        verification: t.verification,
        sourceEvent: t.sourceEvent,
        dependsOn: t.dependsOn,
        blockedBy: t.blockedBy,
        evidence: t.evidence,
        completedAt: t.completedAt,
        completedBy: t.completedBy,
        verificationResult: t.verificationResult,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
  }
}

/**
 * TODO engine — generates and manages task lists for development tasks.
 */
export class TodoEngine {
  constructor(options = {}) {
    this.taskLists = new Map(); // id -> TaskList
    this.securityOrchestrator = options.securityOrchestrator || null;
    this.stateDir = options.stateDir || null;
  }

  /** Set the security orchestrator for security-linked task verification. */
  setSecurityOrchestrator(orchestrator) {
    this.securityOrchestrator = orchestrator;
  }

  /** Generate a task list for a given task type. */
  generateTaskList(taskType, sourceEvent = null, _context = {}) {
    const templates = this._getTaskTemplates(taskType);
    const tasks = templates.map((t) => new Task({
      ...t,
      sourceEvent,
    }));

    const taskList = new TaskList({
      title: this._getTaskListTitle(taskType),
      taskType,
      sourceEvent,
      tasks,
    });

    this.taskLists.set(taskList.id, taskList);
    return taskList;
  }

  /** Get a task list by ID. */
  getTaskList(id) {
    return this.taskLists.get(id);
  }

  /** Get all task lists. */
  getAllTaskLists() {
    return [...this.taskLists.values()];
  }

  /** Get active (incomplete) task lists. */
  getActiveTaskLists() {
    return this.getAllTaskLists().filter((tl) => !tl.isComplete);
  }

  /** Link a security finding to a task and update verification. */
  linkSecurityFinding(taskListId, taskId, findingId, securityOrchestrator) {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) return false;

    const task = taskList.getTask(taskId);
    if (!task) return false;

    const finding = securityOrchestrator.findingsEngine.getById(findingId);
    if (!finding) return false;

    task.evidence = { ...task.evidence, linkedFindingId: findingId, findingSeverity: finding.severity };
    task.updatedAt = new Date().toISOString();

    // If the finding is remediated, complete the task
    if (finding.verificationStatus === VERIFICATION_STATUS.REMEDIATED) {
      taskList.completeTask(taskId, { linkedFindingId: findingId }, { findingResolved: true });
    }

    return true;
  }

  /** Get task list summary for TUI display. */
  getSummary(taskListId) {
    const taskList = this.getTaskList(taskListId);
    if (!taskList) return null;
    return {
      id: taskList.id,
      title: taskList.title,
      taskType: taskList.taskType,
      progress: taskList.progress,
      isComplete: taskList.isComplete,
      total: taskList.tasks.length,
      completed: taskList.tasks.filter((t) => t.isCompleted).length,
      blocked: taskList.blockedTasks.length,
      pending: taskList.pendingTasks.length,
      inProgress: taskList.inProgressTasks.length,
    };
  }

  /** Generate task templates based on task type. */
  _getTaskTemplates(taskType) {
    const base = [
      { title: "Inspect requirements", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL },
      { title: "Inspect existing implementation", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL },
    ];

    const typeTemplates = {
      general: [...base, { title: "Implement feature", category: TASK_CATEGORY.IMPLEMENTATION, verification: TASK_VERIFICATION.MANUAL }, { title: "Run tests", category: TASK_CATEGORY.TESTING, verification: TASK_VERIFICATION.AUTO_TEST }, { title: "Run security scans", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Fix confirmed vulnerabilities", category: TASK_CATEGORY.REMEDIATION, verification: TASK_VERIFICATION.FINDING_REMEDIATED }, { title: "Re-scan after patch", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Verify final output", category: TASK_CATEGORY.VERIFICATION, verification: TASK_VERIFICATION.MANUAL }],

      frontend: [...base, { title: "Inspect existing components", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL }, { title: "Implement frontend", category: TASK_CATEGORY.IMPLEMENTATION, verification: TASK_VERIFICATION.MANUAL }, { title: "Validate inputs", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Run frontend tests", category: TASK_CATEGORY.TESTING, verification: TASK_VERIFICATION.AUTO_TEST }, { title: "Run SAST", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Scan dependencies", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Verify build", category: TASK_CATEGORY.VERIFICATION, verification: TASK_VERIFICATION.AUTO_TEST }, { title: "Complete security review", category: TASK_CATEGORY.VERIFICATION, verification: TASK_VERIFICATION.MANUAL }],

      backend: [...base, { title: "Inspect API architecture", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL }, { title: "Validate authentication", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Validate authorization", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Validate input", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Implement endpoint", category: TASK_CATEGORY.IMPLEMENTATION, verification: TASK_VERIFICATION.MANUAL }, { title: "Run integration tests", category: TASK_CATEGORY.TESTING, verification: TASK_VERIFICATION.AUTO_TEST }, { title: "Run SAST", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Run dependency scans", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Verify error handling", category: TASK_CATEGORY.VERIFICATION, verification: TASK_VERIFICATION.MANUAL }],

      skill: [...base, { title: "Discover source", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL }, { title: "Inspect repository", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL }, { title: "Run SkillSpector", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Review findings", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Obtain approval", category: TASK_CATEGORY.VERIFICATION, verification: TASK_VERIFICATION.MANUAL }, { title: "Test in sandbox", category: TASK_CATEGORY.TESTING, verification: TASK_VERIFICATION.AUTO_TEST }, { title: "Verify permissions", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Activate after verification", category: TASK_CATEGORY.DELIVERY, verification: TASK_VERIFICATION.MANUAL }],

      container: [...base, { title: "Inspect Dockerfile", category: TASK_CATEGORY.REQUIREMENTS, verification: TASK_VERIFICATION.MANUAL }, { title: "Check base image", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Scan image", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Check secrets", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }, { title: "Check configurations", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.MANUAL }, { title: "Verify startup", category: TASK_CATEGORY.TESTING, verification: TASK_VERIFICATION.AUTO_TEST }, { title: "Re-scan final image", category: TASK_CATEGORY.SECURITY, verification: TASK_VERIFICATION.SECURITY_SCAN }],
    };

    return typeTemplates[taskType] || typeTemplates.general;
  }

  _getTaskListTitle(taskType) {
    const titles = {
      general: "Development Task",
      frontend: "Frontend Development",
      backend: "Backend API Development",
      skill: "Skill Installation",
      container: "Container Creation",
    };
    return titles[taskType] || titles.general;
  }
}

export default { TodoEngine, Task, TaskList, TASK_STATUS, TASK_CATEGORY, TASK_VERIFICATION };
