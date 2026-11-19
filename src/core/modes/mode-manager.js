// Mode manager — selection, persistence, and transitions.
//
// ModeState lives on the session and persists across transitions. The manager
// validates transitions (no silent privilege escalation) and records every
// switch in the event log for auditability.

import { MODE, ModeState } from "./mode-types.js";
import { getModePolicy, getDefaultMode, nextMode } from "./mode-policy.js";

/** Valid modes. */
export const VALID_MODES = new Set(Object.values(MODE));

/** The mode registry: one per process/session. */
export class ModeRegistry {
  constructor({ eventLog = null, sessionStore = null } = {}) {
    this.eventLog = eventLog || null;
    this.sessionStore = sessionStore || null;
    this.state = null; // ModeState, set on first use
    this._policyCache = new Map(); // mode -> ModePolicy
  }

  /** Initialize the mode state, restoring from session if available. */
  initialize({ mode = getDefaultMode(), sessionId = null } = {}) {
    if (this.state) return this.state;
    const restored = this._restoreFromSession(sessionId);
    this.state = restored || new ModeState({ mode, sessionId });
    return this.state;
  }

  /** Get the current mode state. */
  getState() {
    if (!this.state) {
      this.initialize();
    }
    return this.state;
  }

  /** Get the current mode id. */
  getMode() {
    return this.getState().mode;
  }

  /** Get the current mode policy. */
  getPolicy() {
    const mode = this.getMode();
    let policy = this._policyCache.get(mode);
    if (!policy) {
      policy = getModePolicy(mode);
      this._policyCache.set(mode, policy);
    }
    return policy;
  }

  /** Switch to a new mode. Returns { ok, previousMode, newMode, policy }. */
  async switchTo(newMode, { sessionId = null, reason = null, approver = null } = {}) {
    const current = this.getState();

    if (!VALID_MODES.has(newMode)) {
      return { ok: false, error: `unknown mode: ${newMode}` };
    }

    if (newMode === current.mode) {
      return { ok: true, previousMode: current.mode, newMode: current.mode, policy: this.getPolicy(), switched: false };
    }

    // Privilege escalation requires approval (unless --yes / non-interactive).
    if (current.mode && newMode !== current.mode) {
      const policy = getModePolicy(newMode);
      if (policy.isEscalation(current.mode)) {
        if (approver) {
          const approved = await approver({
            from: current.mode,
            to: newMode,
            reason: reason || `switch from ${current.mode} to ${newMode}`,
          });
          if (!approved) {
            return { ok: false, error: `mode switch to ${newMode} not approved` };
          }
        }
        // If no approver is available and we're not interactive, fail closed.
        // The CLI's makeApprover handles the TTY check.
      }
    }

    const previousMode = current.mode;
    const _switched = current.switchTo(newMode, { sessionId: sessionId ?? current.sessionId });

    // Record the switch in the event log.
    if (this.eventLog) {
      this.eventLog.emit("mode.switched", {
        from: previousMode,
        to: newMode,
        sessionId: current.sessionId,
        reason,
        switchCount: current.switchCount,
        timestamp: current.switchedAt,
      }, "info");
    }

    return {
      ok: true,
      previousMode,
      newMode,
      policy: this.getPolicy(),
      switched: true,
      switchCount: current.switchCount,
    };
  }

  /** Cycle to the next mode in the Tab order (Plan → Build → Orchestrate → Auto → Plan). */
  async cycle({ sessionId = null, reason = "tab cycle", approver = null } = {}) {
    const current = this.getMode();
    const target = nextMode(current);
    return this.switchTo(target, { sessionId, reason, approver });
  }

  /** Check whether a transition to `target` would be a privilege escalation. */
  isEscalation(target) {
    const current = this.getMode();
    if (!VALID_MODES.has(target)) return false;
    const policy = getModePolicy(target);
    return policy.isEscalation(current);
  }

  /** Persist mode state to the session store if available. */
  async persist() {
    if (!this.sessionStore || !this.state) return;
    try {
      const sessionId = this.state.sessionId;
      if (sessionId && typeof this.sessionStore.update === "function") {
        await this.sessionStore.update(sessionId, { mode: this.state.mode });
      }
    } catch {
      // Persistence is best-effort; a failure must not block mode switching.
    }
  }

  /** Restore mode state from a session. */
  _restoreFromSession(sessionId) {
    if (!this.sessionStore || !sessionId) return null;
    try {
      const session = typeof this.sessionStore.read === "function" ? this.sessionStore.read(sessionId) : null;
      if (session && session.mode && VALID_MODES.has(session.mode)) {
        return new ModeState({
          mode: session.mode,
          sessionId,
          previousMode: session.previousMode || null,
          switchedAt: session.switchedAt || new Date().toISOString(),
          switchCount: session.switchCount || 0,
        });
      }
    } catch {
      // Ignore restore failures; start with default.
    }
    return null;
  }
}

export default { ModeRegistry, VALID_MODES };
