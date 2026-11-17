// Semantic color palette definitions for AgentFlow themes.
//
// Every theme defines the same set of semantic tokens. The paint system in
// ui.js maps style names to ANSI codes; themes override those mappings by
// name, so a theme is just a record of style-name → color-spec.
//
// Color specs are strings understood by ui.js paint(): a hex color, an ANSI
// 256-color index, or a named style. When colour is disabled (NO_COLOR, TERM
// dumb) all themes degrade to plain text automatically.

/** Base semantic token set every theme must provide. */
export const SEMANTIC_TOKENS = [
  // Structural
  "background", "surface", "elevated", "border", "borderFocus",
  // Text hierarchy
  "primaryText", "secondaryText", "mutedText", "inverseText",
  // Accents
  "accent", "accentSecondary", "accentMuted",
  // Status
  "success", "warning", "error", "info",
  // Selection & interaction
  "selection", "selectionText", "cursor", "cursorText",
  // Message roles
  "userMessage", "assistantMessage", "systemMessage",
  // Tool / execution
  "toolOutput", "toolError", "toolPending", "toolSuccess",
  // Code & diff
  "codeKeyword", "codeString", "codeComment", "codeFunction",
  "diffAdd", "diffDel", "diffHunk",
  // Permission
  "permissionAllow", "permissionDeny", "permissionWarn",
  // Tribunal / flowline
  "tribunalForge", "tribunalCrucible", "tribunalMerge", "tribunalTrial", "tribunalOracle",
  "flowlineActive", "flowlineIdle", "flowlineError",
];

/** Default fallback theme (used when a requested theme is missing). */
export const DEFAULT_THEME_NAME = "neural-core";

/** Color category groupings for the theme selector UI. */
export const THEME_CATEGORIES = {
  futuristic: "Futuristic",
  minimal: "Minimal",
  nature: "Nature & Atmosphere",
  developer: "Developer Inspired",
};
