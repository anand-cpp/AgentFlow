// Repository map, phase 6: the token-budget context packer.
//
// A ranked map is not a prompt. This module turns a snapshot into a compact
// markdown block that fits a hard token budget and answers one question for
// the model: "what does this repo look like, structurally, right now?".
//
// Three knobs steer what survives the cut:
//   maxTokens         the whole block's budget (chars/4 as the token estimate)
//   focusFiles        files the caller already cares about get a boost
//   query             free text whose keywords match paths and symbol names
//
// Invariants, tested: the emitted text never exceeds the budget (accounted
// exactly over the final rendered string, blank lines included), the header
// is always there, a cut list always says so, and file contents are never
// dumped — symbols and structure only.

const CHARS_PER_TOKEN = 4;

export const DEFAULT_MAX_TOKENS = 2000;
export const DEFAULT_MAX_SYMBOLS_PER_FILE = 5;

/** Rough token estimate: 4 chars ≈ 1 token. */
export function estimateTokens(text) {
  return Math.max(text.length ? 1 : 0, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Keyword-match a file against a free-text query: path segments and symbol
 * names, so "chat" matches "chat.js" but "at" never does.
 */
export function queryMatches(rel, symbols, query) {
  const tokens = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  const haystack = `${rel.toLowerCase()} ${symbols.map((s) => s.name.toLowerCase()).join(" ")}`;
  let hits = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) hits += 1;
  }
  return hits;
}

/**
 * @param {object} map a snapshot from buildMap()/loadMap()
 * @param {{
 *   maxTokens?: number,
 *   maxSymbolsPerFile?: number,
 *   focusFiles?: string[],
 *   query?: string,
 *   title?: string,
 * }} [options]
 * @returns {string} the prompt block, always within budget
 */
export function formatRepoMapForPrompt(map, options = {}) {
  const maxTokens = Math.max(16, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const maxSymbolsPerFile = Math.max(1, options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE);
  const focusSet = new Set((options.focusFiles ?? []).map(normalise).filter(Boolean));
  const query = options.query ?? "";

  const header = options.title ?? "## Repository map";
  const intro = "Ranked by structural importance. ★ = touched by the current task.";

  const scores = new Map((map.scores ?? []).map((s) => [s.id, s.score]));
  // Inbound-reference counts straight from the units, no graph rebuild.
  const inbound = new Map();
  for (const unit of map.units ?? []) {
    for (const imp of unit.imports ?? []) {
      if (!imp.resolved) continue;
      inbound.set(imp.resolved, (inbound.get(imp.resolved) ?? 0) + 1);
    }
  }

  const unitsByFile = new Map((map.units ?? []).map((u) => [u.file, u]));
  const entries = (map.files ?? []).map((f) => {
    const rel = normalise(f.rel);
    const unit = unitsByFile.get(rel) ?? { file: rel, symbols: [], imports: [] };
    const score = scores.get(rel) ?? 0;
    const keywordHits = queryMatches(rel, unit.symbols ?? [], query);
    const focused = focusSet.has(rel);
    // Multiplicative keyword boost, additive focus boost: a focused file the
    // query never names still belongs near the top.
    const boosted = score * (1 + 0.5 * keywordHits) + (focused ? 0.1 : 0);
    return { rel, unit, score: boosted, focused };
  });
  entries.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

  // Fixed prefix: the header always survives; the intro only when it fits.
  let base = header;
  if (estimateTokens(`${base}\n${intro}`) <= maxTokens) base = `${base}\n${intro}`;

  const lines = entries.map((entry) =>
    fileLine(entry, inbound.get(entry.rel) ?? 0, maxSymbolsPerFile),
  );
  const total = lines.length;

  // 1) Pack greedily upward to find the largest prefix that fits bare.
  let packed = base;
  let packedCount = 0;
  while (packedCount < total) {
    const candidate = `${packed}\n\n${lines[packedCount]}`;
    if (estimateTokens(candidate) > maxTokens) break;
    packed = candidate;
    packedCount += 1;
  }
  if (packedCount === total) return packed;

  // 2) The list was cut, so it must be announced. Trade file slots for the
  //    note until both fit; the note is worth more than one more line.
  for (let shown = packedCount; shown >= 0; shown -= 1) {
    const body = lines.slice(0, shown).join("\n\n");
    const note = `(truncated: ${shown} of ${total} files shown)`;
    const candidate = body ? `${base}\n\n${body}\n\n${note}` : `${base}\n\n${note}`;
    if (estimateTokens(candidate) <= maxTokens) return candidate;
  }

  // 3) Pathological budget: not even header+note fit. Header only, capped.
  return base.slice(0, Math.max(4, maxTokens * CHARS_PER_TOKEN));
}

function fileLine(entry, inboundCount, maxSymbolsPerFile) {
  const star = entry.focused ? " ★" : "";
  const symbols = [...(entry.unit.symbols ?? [])]
    .sort((a, b) => Number(b.exported) - Number(a.exported) || a.line - b.line)
    .slice(0, maxSymbolsPerFile)
    .map((s) => s.name);
  const more = (entry.unit.symbols?.length ?? 0) - symbols.length;
  const symbolPart = symbols.length ? ` — ${symbols.join(", ")}${more > 0 ? `, +${more} more` : ""}` : "";
  const refsPart = inboundCount > 0 ? `; referenced by ${inboundCount}` : "";
  return `- ${entry.rel}${star}${symbolPart}${refsPart}`;
}

function normalise(rel) {
  return String(rel).replaceAll("\\", "/");
}

export default formatRepoMapForPrompt;
