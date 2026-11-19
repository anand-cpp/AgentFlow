// Hackathon Mode task lifecycle state machine.
//
// Valid task transitions:
//
//   PENDING → ASSIGNED → ACCEPTED → RUNNING → COMPLETED
//
// Exception states (terminal or transient):
//
//   BLOCKED, FAILED, CANCELLED, EXPIRED
//
// Rules:
//   - A task may only be ASSIGNED by the coordinator to a worker.
//   - A task may only be ACCEPTED by the assigned worker.
//   - A task may only be STARTED by the assigned worker while holding a lease.
//   - A task may only be COMPLETED by the assigned worker with required evidence.
//   - A task may transition to BLOCKED, FAILED, or CANCELLED from ASSIGNED,
//     ACCEPTED, or RUNNING.
//   - EXPIRED is set by the coordinator when a lease lapses without renewal.
//   - Once COMPLETED, FAILED, or CANCELLED, a task may not transition again
//     except back to PENDING via coordinator-led reassignment.

import { TASK_STATUS } from "./session.js";
export { TASK_STATUS };

const STATUSES = new Set(Object.values(TASK_STATUS));

// Allowed transitions: from -> Set of allowed to states.
const TRANSITIONS = {
  [TASK_STATUS.PENDING]: new Set([TASK_STATUS.ASSIGNED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.ASSIGNED]: new Set([
    TASK_STATUS.ACCEPTED,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.EXPIRED,
  ]),
  [TASK_STATUS.ACCEPTED]: new Set([
    TASK_STATUS.RUNNING,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.EXPIRED,
  ]),
  [TASK_STATUS.RUNNING]: new Set([
    TASK_STATUS.COMPLETED,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.EXPIRED,
  ]),
  [TASK_STATUS.BLOCKED]: new Set([
    TASK_STATUS.RUNNING,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.ASSIGNED,
  ]),
  [TASK_STATUS.FAILED]: new Set([TASK_STATUS.ASSIGNED, TASK_STATUS.CANCELLED]),
  [TASK_STATUS.CANCELLED]: new Set([TASK_STATUS.PENDING]),
  [TASK_STATUS.EXPIRED]: new Set([TASK_STATUS.ASSIGNED, TASK_STATUS.CANCELLED]),
};

/** Terminal states: once reached, no normal execution transitions remain. */
const TERMINAL_STATES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);

/** Validate a state transition. Returns { ok, reason? }. */
export function validateTransition(from, to) {
  if (!STATUSES.has(from)) {
    return { ok: false, reason: `invalid from state: ${from}` };
  }
  if (!STATUSES.has(to)) {
    return { ok: false, reason: `invalid to state: ${to}` };
  }
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    return { ok: false, reason: `no transitions defined for ${from}` };
  }
  if (!allowed.has(to)) {
    return { ok: false, reason: `transition ${from} → ${to} not allowed` };
  }
  return { ok: true };
}

/** Whether a state is terminal. */
export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/** Whether a state represents active execution. */
export function isActive(state) {
  return state === TASK_STATUS.ASSIGNED ||
    state === TASK_STATUS.ACCEPTED ||
    state === TASK_STATUS.RUNNING ||
    state === TASK_STATUS.BLOCKED;
}

/** Whether a state means the task is available for (re)assignment. */
export function isAssignable(state) {
  return state === TASK_STATUS.PENDING ||
    state === TASK_STATUS.EXPIRED ||
    state === TASK_STATUS.FAILED ||
    state === TASK_STATUS.CANCELLED;
}

export default {
  TASK_STATUS,
  validateTransition,
  isTerminal,
  isActive,
  isAssignable,
  TRANSITIONS,
};
