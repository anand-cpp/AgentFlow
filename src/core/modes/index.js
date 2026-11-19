// Operating modes — public API.
// Re-exports types, policies, manager, runtime, and orchestrator.

import {
  MODE,
  MODE_NAMES,
  MODE_DESCRIPTIONS,
  MODE_CYCLE,
  MODE_PRIVILEGE,
  ModePolicy,
  ModeState,
} from "./mode-types.js";
import {
  MODE_POLICIES,
  getModePolicy,
  getDefaultMode,
  nextMode,
  PLAN_POLICY,
  BUILD_POLICY,
  ORCHESTRATE_POLICY,
  AUTO_POLICY,
} from "./mode-policy.js";
import { ModeRegistry, VALID_MODES } from "./mode-manager.js";
import { ModeRuntime, buildToolPolicy, buildBounds, buildModelRequirements } from "./mode-runtime.js";
import { ModeOrchestrator, SubtaskResult, OrchestrationResult } from "./mode-orchestrator.js";

export {
  MODE,
  MODE_NAMES,
  MODE_DESCRIPTIONS,
  MODE_CYCLE,
  MODE_PRIVILEGE,
  ModePolicy,
  ModeState,
  MODE_POLICIES,
  getModePolicy,
  getDefaultMode,
  nextMode,
  PLAN_POLICY,
  BUILD_POLICY,
  ORCHESTRATE_POLICY,
  AUTO_POLICY,
  ModeRegistry,
  VALID_MODES,
  ModeRuntime,
  buildToolPolicy,
  buildBounds,
  buildModelRequirements,
  ModeOrchestrator,
  SubtaskResult,
  OrchestrationResult,
};

export default {
  MODE,
  MODE_NAMES,
  MODE_DESCRIPTIONS,
  MODE_CYCLE,
  MODE_PRIVILEGE,
  ModePolicy,
  ModeState,
  MODE_POLICIES,
  getModePolicy,
  getDefaultMode,
  nextMode,
  ModeRegistry,
  VALID_MODES,
  ModeRuntime,
  ModeOrchestrator,
  SubtaskResult,
  OrchestrationResult,
};
