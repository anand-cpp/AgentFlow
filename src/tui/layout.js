// Responsive multi-region layout engine for AgentFlow TUI.
//
// Divides the terminal into regions: header, sidebar, main, inspector, prompt.
// Each region reports its available width/height so components can render
// appropriately. The layout collapses gracefully on narrow terminals.

export const REGIONS = {
  HEADER: "header",
  SIDEBAR: "sidebar",
  MAIN: "main",
  INSPECTOR: "inspector",
  PROMPT: "prompt",
};

/** Default region proportions (fractions of width/height). */
const DEFAULT_PROPORTIONS = {
  sidebarWidth: 24,      // columns
  inspectorWidth: 42,    // columns
  headerHeight: 3,       // rows
  promptHeight: 4,       // rows
};

/**
 * Compute region rectangles for the current terminal size.
 *
 * @param {object} dims { cols, rows }
 * @param {object} [opts] overrides for proportions
 * @returns {Map<region, {x, y, w, h}>}
 */
export function computeLayout(dims, opts = {}) {
  const { cols, rows } = dims;
  const p = { ...DEFAULT_PROPORTIONS, ...opts };

  const isNarrow = cols < 100;
  const isShort = rows < 30;

  // On narrow terminals, collapse sidebar and inspector into overlays
  const sidebarW = isNarrow ? 0 : Math.min(p.sidebarWidth, Math.floor(cols * 0.25));
  const inspectorW = isNarrow ? 0 : Math.min(p.inspectorWidth, Math.floor(cols * 0.22));
  const headerH = isShort ? 2 : p.headerHeight;
  const promptH = isShort ? 3 : p.promptHeight;

  const regions = new Map();

  // Header: full width, top
  regions.set(REGIONS.HEADER, { x: 0, y: 0, w: cols, h: headerH });

  // Sidebar: left column below header
  regions.set(REGIONS.SIDEBAR, {
    x: 0,
    y: headerH,
    w: sidebarW,
    h: rows - headerH - promptH,
  });

  // Inspector: right column below header
  const inspectorX = cols - inspectorW;
  regions.set(REGIONS.INSPECTOR, {
    x: inspectorX,
    y: headerH,
    w: inspectorW,
    h: rows - headerH - promptH,
  });

  // Main: between sidebar and inspector, below header, above prompt
  const mainX = sidebarW;
  const mainW = cols - sidebarW - inspectorW;
  regions.set(REGIONS.MAIN, {
    x: mainX,
    y: headerH,
    w: Math.max(1, mainW),
    h: rows - headerH - promptH,
  });

  // Prompt: full width, bottom
  regions.set(REGIONS.PROMPT, {
    x: 0,
    y: rows - promptH,
    w: cols,
    h: promptH,
  });

  return regions;
}

/** Get terminal dimensions with sane fallbacks. */
export function terminalDims() {
  return {
    cols: Math.max(40, process.stdout.columns || Number(process.env.COLUMNS) || 80),
    rows: Math.max(20, process.stdout.rows || Number(process.env.LINES) || 40),
  };
}

/** Format a region's content area (subtracting borders/padding). */
export function contentArea(region) {
  return {
    x: region.x + 1,
    y: region.y + 1,
    w: Math.max(1, region.w - 2),
    h: Math.max(1, region.h - 2),
  };
}
