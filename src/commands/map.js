// `aflow map` and the `/map` chat slash.
//
// Front door for the repository map: show the ranked structure, force a
// rebuild, ask a keyword-personalized question of the graph, or inspect the
// cache's vital statistics. Reads/builds are local and synchronous-ish, so
// unlike `mcp`/`lsp` there is no server lifecycle to manage around it; the
// dispatcher is a pure read over the cache with an explicit opt-in rebuild.

import path from "node:path";
import { defineCommand } from "../cli/registry.js";
import { buildMap, loadMap, refreshMap, mapFreshness, cachePathFor } from "../core/map/build.js";
import { formatRepoMapForPrompt } from "../core/map/context.js";
import { bold, dim, green, heading, red, yellow } from "../cli/ui.js";

const FAILURE = 1;
const SHOW_LIMIT = 25;

function scorePercent(score) {
  const pct = score * 100;
  return pct >= 0.1 ? pct.toFixed(1) : "<0.1";
}

/** Strip symbol nodes (`file#name`) and external stubs from the ranking. */
export function fileRanking(map) {
  return (map.scores ?? [])
    .filter((s) => !s.id.startsWith("external:") && !s.id.includes("#"))
    .sort((a, b) => b.score - a.score);
}

/** Render `aflow map show`: ranked files with their top symbols. */
function renderShow(map, limit = SHOW_LIMIT) {
  const units = new Map((map.units ?? []).map((u) => [u.file, u]));
  const lines = [heading(`repository map — ${map.stats?.files ?? map.files?.length ?? 0} files`),
    dim(`cache: ${cachePathFor(map.root ?? process.cwd())}`), ""];
  const ranking = fileRanking(map);
  if (!ranking.length) return yellow("no files in the map — is this workspace empty?");
  for (const entry of ranking.slice(0, limit)) {
    const unit = units.get(entry.id);
    const symbols = (unit?.symbols ?? [])
      .filter((s) => s.exported)
      .slice(0, 4)
      .map((s) => s.name);
    const more = (unit?.symbols?.filter((s) => s.exported)?.length ?? 0) - symbols.length;
    const tail = symbols.length ? ` ${dim(symbols.join(", ") + (more > 0 ? `, +${more}` : ""))}` : "";
    lines.push(`${bold(entry.id)} ${dim(scorePercent(entry.score) + "%")}${tail}`);
  }
  if (ranking.length > limit) lines.push(dim(`…and ${ranking.length - limit} more`));
  if (map.truncated) lines.push(yellow("(walk truncated at the file cap — rank covers a subset)"));
  return lines.join("\n");
}

/** Render `aflow map stats`: cache vitals. */
function renderStats(map) {
  const generatedAt = Number(map.generatedAt) || 0;
  const ageS = generatedAt ? Math.max(0, Math.round((Date.now() - generatedAt) / 1000)) : null;
  const fresh = mapFreshness(map.root);
  const lines = [
    heading("repo map stats"),
    `files          ${bold(String(map.stats?.files ?? map.files?.length ?? 0))}`,
    `graph nodes    ${bold(String(map.stats?.nodes ?? 0))} (files + symbols + external stubs)`,
    `graph edges    ${bold(String(map.stats?.edges ?? 0))}`,
    `cache          ${dim(cachePathFor(map.root))}`,
    `age            ${ageS === null ? dim("unknown") : dim(`${ageS}s ago`)}`,
    `freshness      ${fresh.stale ? yellow(`stale${fresh.reason ? ` — ${fresh.reason} changed` : ""}`) : green("fresh")}`,
  ];
  const top = fileRanking(map).slice(0, 10);
  if (top.length) lines.push("", dim("top 10:"), ...top.map((e) => `  ${bold(e.id)} ${dim(scorePercent(e.score) + "%")}`));
  return lines.join("\n");
}

/**
 * Shared dispatcher behind the CLI command and the /map slash.
 *
 * @param {string} root
 * @param {string[]} tokens
 * @returns {Promise<{ ok: boolean, text: string, data: any }>}
 */
export async function dispatchMap(root, tokens) {
  const [sub = "show", ...rest] = tokens;

  if (sub === "help" || sub === "--help") {
    return { ok: true, text: mapCommand.usage, data: { usage: mapCommand.usage } };
  }
  if (!["show", "build", "query", "stats"].includes(sub)) {
    return { ok: false, text: red(`unknown map subcommand: ${sub}`), data: { error: `unknown subcommand: ${sub}` } };
  }

  try {
    if (sub === "build") {
      const snapshot = buildMap(root);
      return {
        ok: true,
        text: `${green("rebuilt")} ${heading(`repository map`)}: ${snapshot.stats.files} files, ${snapshot.stats.nodes} nodes, ${snapshot.stats.edges} edges`,
        data: { stats: snapshot.stats, truncated: snapshot.truncated },
      };
    }

    if (sub === "stats") {
      const existing = loadMap(root);
      if (!existing) {
        const snapshot = buildMap(root);
        return { ok: true, text: `${renderStats(snapshot)}\n${dim("(map was missing; built just now)")}`, data: { stats: snapshot.stats } };
      }
      return { ok: true, text: renderStats(existing), data: { stats: existing.stats } };
    }

    if (sub === "query") {
      const query = rest.join(" ").trim();
      if (!query) {
        return { ok: false, text: red("usage: aflow map query <text>"), data: { error: "missing query text" } };
      }
      let map = loadMap(root);
      let built = false;
      if (!map) {
        map = buildMap(root);
        built = true;
      } else {
        map = refreshMap(root, { write: true }).snapshot;
      }
      const text = formatRepoMapForPrompt(map, { query, maxTokens: 800 });
      return {
        ok: true,
        text: `${built ? dim("(map built first; subsequent queries are cache-fed)\n") : ""}${text}`,
        data: { query, map: text },
      };
    }

    // show
    let map = loadMap(root);
    if (!map) map = buildMap(root);
    return { ok: true, text: renderShow(map), data: { map: { files: map.files, stats: map.stats } } };
  } catch (err) {
    const message = err?.message ?? String(err);
    return { ok: false, text: red(`map ${sub} failed: ${message}`), data: { error: message } };
  }
}

/**
 * The chat `/map` handler.
 * @param {string} arg text after /map
 * @param {{ root: string }} opts
 * @returns {Promise<string>}
 */
export async function mapSlash(arg, { root }) {
  const tokens = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const result = await dispatchMap(root, tokens);
  return result.text;
}

export const mapCommand = defineCommand("map", {
  summary: "show the PageRank-ranked structural map of this workspace",
  valueFlags: ["project"],
  usage: `aflow map [show]
  aflow map build
  aflow map query <text>
  aflow map stats

Builds and caches a structural map of the workspace (files, symbols, import
graph) and ranks it with PageRank, Aider-style. Show prints the highest-ranked
files and their exported symbols; query re-ranks around keywords you provide —
the same ranking the agent runtime sees in its repository-map context.

Inside a chat, the same dispatcher is reachable as /map <subcommand>.

  --project PATH   map another directory
  --json           machine-readable output

Exit codes: 0 ok, 1 a map failure, 2 usage.`,
  run: async ({ args, flags, out }) => {
    const root = flags && flags.project ? path.resolve(String(flags.project)) : process.cwd();
    const result = await dispatchMap(root, args || []);
    await out.init(result.data, () => result.text);
    return result.ok ? 0 : FAILURE;
  },
});

export default mapCommand;
