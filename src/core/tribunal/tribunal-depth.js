// Tribunal depth knob.
//
// Maps a depth name (quick / standard / deep / inquisition) to the preset the
// five-stage pipeline uses: how many models Forge draws on, how many Crucible
// attack rounds run, which Oracle mode applies, and whether the run may iterate
// until convergence (inquisition, hard-capped by a timeout so it can never loop
// forever).
//
// The depth is a *capacity* knob, not a quality guarantee: a quick run can still
// return VERIFIED, and an inquisition run can still return ABORTED. The gate
// (CONFIDENCE_THRESHOLD = 0.95) is unchanged by depth.

export const DEPTH_QUICK = "quick";
export const DEPTH_STANDARD = "standard";
export const DEPTH_DEEP = "deep";
export const DEPTH_INQUISITION = "inquisition";

export const DEPTH_DEFAULT = DEPTH_STANDARD;

// Inquisition hard cap: the loop has a wall-clock limit so it can never spin
// forever even if convergence never arrives. Five minutes is generous enough
// for a deep review but short enough that a blocked run is surfaced quickly.
export const INQUISITION_HARD_TIMEOUT_MS = 300_000;

// How many consecutive Crucible rounds with zero new P0/P1 findings constitute
// "convergence" for the inquisition early-termination path.
export const INQUISITION_CONVERGENCE_ROUNDS = 2;

/** Preset for each depth. `models` null means "no model cap" (inquisition). */
export const DEPTH_PRESETS = Object.freeze({
  [DEPTH_QUICK]: Object.freeze({
    models: 2,
    rounds: 1,
    oracleMode: "lite",
    earlyTermination: false,
    hardTimeoutMs: null,
  }),
  [DEPTH_STANDARD]: Object.freeze({
    models: 3,
    rounds: 2,
    oracleMode: "full",
    earlyTermination: false,
    hardTimeoutMs: null,
  }),
  [DEPTH_DEEP]: Object.freeze({
    models: 5,
    rounds: 3,
    oracleMode: "full",
    earlyTermination: false,
    hardTimeoutMs: null,
  }),
  [DEPTH_INQUISITION]: Object.freeze({
    models: null,
    rounds: null,
    oracleMode: "full",
    earlyTermination: true,
    hardTimeoutMs: INQUISITION_HARD_TIMEOUT_MS,
  }),
});

/** Depth names in order of increasing effort, for UIs that want to list them. */
export const DEPTH_NAMES = Object.freeze([DEPTH_QUICK, DEPTH_STANDARD, DEPTH_DEEP, DEPTH_INQUISITION]);

/**
 * Resolve a depth name to its preset. Unknown or missing names fall back to the
 * standard preset so a run never fails on an unrecognized depth.
 *
 * @param {string|null|undefined} [name]
 * @returns {{ models: number|null, rounds: number|null, oracleMode: "lite"|"full", earlyTermination: boolean, hardTimeoutMs: number|null }}
 */
export function resolveDepth(name) {
  const preset = name && DEPTH_PRESETS[name];
  return preset ? preset : DEPTH_PRESETS[DEPTH_DEFAULT];
}

/** True when `name` is one of the four recognized depth names. */
export function isValidDepth(name) {
  return Boolean(name && Object.prototype.hasOwnProperty.call(DEPTH_PRESETS, name));
}

export default {
  DEPTH_QUICK,
  DEPTH_STANDARD,
  DEPTH_DEEP,
  DEPTH_INQUISITION,
  DEPTH_DEFAULT,
  DEPTH_PRESETS,
  DEPTH_NAMES,
  INQUISITION_HARD_TIMEOUT_MS,
  INQUISITION_CONVERGENCE_ROUNDS,
  resolveDepth,
  isValidDepth,
};
