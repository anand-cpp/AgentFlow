// Theme engine — semantic color registry for AgentFlow.
//
// Themes are collections of semantic color tokens (see theme-colors.js). The
// paint system in src/cli/ui.js resolves style names to ANSI codes; this
// module bridges theme names to style names so every TUI component can ask
// for "accent" or "error" and get the right color for the active theme.
//
// Zero runtime dependencies: plain JS objects, no frameworks.

import { SEMANTIC_TOKENS, DEFAULT_THEME_NAME } from "./theme-colors.js";
import * as futuristic from "./themes/futuristic.js";
import * as minimal from "./themes/minimal.js";
import * as nature from "./themes/nature.js";
import * as developer from "./themes/developer.js";
import { paint, isColorEnabled } from "../cli/ui.js";

// ── Theme registry ──────────────────────────────────────────────────────

const THEME_REGISTRY = new Map();

// Register each theme by its id (exported variable name).
function registerTheme(theme) {
  if (!theme || !theme.colors) {
    throw new Error(`theme engine: invalid theme ${theme?.name ?? "<unknown>"}`);
  }
  // Validate every semantic token is present.
  for (const token of SEMANTIC_TOKENS) {
    if (!(token in theme.colors)) {
      throw new Error(
        `theme engine: theme "${theme.name}" missing semantic token "${token}"`,
      );
    }
  }
  THEME_REGISTRY.set(theme.name.toLowerCase().replace(/\s+/g, "-"), theme);
}

// Register all themes from each collection.
function registerAll(collection) {
  for (const [, value] of Object.entries(collection)) {
    if (value && value.colors && value.name) {
      registerTheme(value);
    }
  }
}

registerAll(futuristic);
registerAll(minimal);
registerAll(nature);
registerAll(developer);

// ── Active theme state ──────────────────────────────────────────────────

let activeThemeId = DEFAULT_THEME_NAME.toLowerCase().replace(/\s+/g, "-");
let _userThemeId = null; // explicitly chosen theme, if any

/** Get the currently active theme object. */
export function getActiveTheme() {
  return THEME_REGISTRY.get(activeThemeId) || THEME_REGISTRY.get(DEFAULT_THEME_NAME.toLowerCase().replace(/\s+/g, "-"));
}

/** Get the theme object by id (e.g. "neural-core"). Returns undefined if missing. */
export function getThemeById(id) {
  return THEME_REGISTRY.get(id.toLowerCase().replace(/\s+/g, "-"));
}

/** List all registered theme ids. */
export function listThemeIds() {
  return [...THEME_REGISTRY.keys()].sort();
}

/** List themes grouped by category. */
export function listThemesByCategory() {
  const grouped = {};
  for (const theme of THEME_REGISTRY.values()) {
    const cat = theme.category || "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(theme);
  }
  for (const cat of Object.keys(grouped)) {
    grouped[cat].sort((a, b) => a.name.localeCompare(b.name));
  }
  return grouped;
}

/** Set the active theme by id. Returns true if the theme exists. */
export function setTheme(id) {
  const theme = getThemeById(id);
  if (!theme) return false;
  activeThemeId = id.toLowerCase().replace(/\s+/g, "-");
  _userThemeId = activeThemeId;
  return true;
}

/** Reset to the default theme. */
export function resetTheme() {
  activeThemeId = DEFAULT_THEME_NAME.toLowerCase().replace(/\s+/g, "-");
  _userThemeId = null;
}

/** Resolve a semantic token name to its color spec under the active theme. */
export function resolveToken(token) {
  const theme = getActiveTheme();
  if (!theme) return undefined;
  return theme.colors[token];
}

/** Total theme count. */
export function themeCount() {
  return THEME_REGISTRY.size;
}

// ── Paint-system bridge ─────────────────────────────────────────────────

/**
 * Paint text with a semantic token color under the active theme.
 *
 * Falls back to the raw token name if the theme doesn't define it, then to
 * plain text if colour is disabled. Delegates to ui.js paint().
 *
 * @param {string} text
 * @param {string} token  semantic token name (e.g. "accent", "error")
 * @param {...string} extraStyles  additional ui.js styles (bold, dim, etc.)
 * @returns {string}
 */
export function paintToken(text, token, ...extraStyles) {
  if (!isColorEnabled()) return text;
  const color = resolveToken(token);
  if (!color) return paint(text, ...extraStyles);
  return paint(text, color, ...extraStyles);
}
