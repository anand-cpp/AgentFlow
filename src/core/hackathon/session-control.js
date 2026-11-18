// Session pause/resume control for Hackathon Mode.
//
// Allows the leader to pause and resume session execution. When paused, no
// new tasks are dispatched and workers are notified. When resumed, the
// executor resumes dispatching ready tasks.

import { SESSION_STATUS } from "./session.js";

/** SessionControl — pause/resume lifecycle for a Hackathon session. */
export class SessionControl {
  constructor({ coordinator = null, executor = null } = {}) {
    this.coordinator = coordinator || null;
    this.executor = executor || null;
  }

  /** Pause the session. No new tasks are dispatched while paused. */
  async pause() {
    if (!this.coordinator) {
      return { ok: false, error: new Error("no coordinator") };
    }

    if (!this.coordinator.session) {
      return { ok: false, error: new Error("no active session") };
    }

    if (this.coordinator.session.status === SESSION_STATUS.PAUSED) {
      return { ok: true, message: "already paused" };
    }

    this.coordinator.session.status = SESSION_STATUS.PAUSED;
    this.coordinator.session.updatedAt = new Date().toISOString();

    // Stop the executor's dispatch loop.
    if (this.executor) {
      this.executor.stop();
    }

    // Persist.
    if (this.coordinator.session.projectRoot) {
      // Session persistence handled by coordinator; here we just mark state.
    }

    return { ok: true, status: SESSION_STATUS.PAUSED };
  }

  /** Resume the session. Task dispatching resumes. */
  async resume() {
    if (!this.coordinator) {
      return { ok: false, error: new Error("no coordinator") };
    }

    if (!this.coordinator.session) {
      return { ok: false, error: new Error("no active session") };
    }

    if (this.coordinator.session.status === SESSION_STATUS.ACTIVE) {
      return { ok: true, message: "already active" };
    }

    this.coordinator.session.status = SESSION_STATUS.ACTIVE;
    this.coordinator.session.updatedAt = new Date().toISOString();

    // Restart the executor's dispatch loop.
    if (this.executor) {
      this.executor.start();
    }

    return { ok: true, status: SESSION_STATUS.ACTIVE };
  }

  /** Get the current session status. */
  getStatus() {
    if (!this.coordinator || !this.coordinator.session) {
      return null;
    }
    return this.coordinator.session.status;
  }

  /** Is the session paused? */
  isPaused() {
    return this.getStatus() === SESSION_STATUS.PAUSED;
  }

  /** Is the session active? */
  isActive() {
    return this.getStatus() === SESSION_STATUS.ACTIVE;
  }
}

export default { SessionControl };
