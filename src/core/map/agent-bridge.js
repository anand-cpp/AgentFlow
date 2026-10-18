// Repository map, phase 7: the agent runtime bridge.
//
// Two products come out of here:
//
//   1. the `repo-map` tool, registered into the runtime's tool map so the
//      model can pull fresh structural context on demand mid-run;
//   2. an "extra" section string the run call can inline into the context
//      packet, so every task starts with the map already in view.
//
// Both are strictly best-effort: a missing cache, an unreadable workspace, a
// formatting hiccup — every path degrades to "no map", never a run failure.
// The bridge is also honest about staleness: it refreshes when the cache is
// behind the tree (cheap mtime check first), and rate-limits itself so a long
// tool-loop cannot hammer the walk every iteration.

import { refreshMap, loadMap } from "./build.js";
import { formatRepoMapForPrompt } from "./context.js";
import { TOOL_SCOPE } from "../agents/registry.js";

/** Min ms between refresh attempts; protects a tool loop from walk storms. */
const REFRESH_COOLDOWN_MS = 2000;

export class RepoMapAgentBridge {
  /**
   * @param {{ root?: string, config?: object, now?: () => number }} [options]
   */
  constructor({ root, config = {}, now = Date.now } = {}) {
    this.root = String(root || process.cwd());
    // Enabled by default; both key styles turn it off explicitly.
    this.enabled = config?.mapEnabled !== false && config?.map?.enabled !== false;
    this.maxTokens = Number.isFinite(config?.mapMaxPromptTokens) && config.mapMaxPromptTokens > 0
      ? config.mapMaxPromptTokens
      : 2000;
    this.maxFiles = Number.isFinite(config?.mapMaxFiles) && config.mapMaxFiles > 0
      ? config.mapMaxFiles
      : undefined;
    this.languages = Array.isArray(config?.mapLanguages) && config.mapLanguages.length
      ? config.mapLanguages
      : undefined;
    this._now = now;
    this._lastFreshCheck = 0;
    this._lastSnapshot = null;
  }

  /**
   * Make sure the cache exists and is not provably behind the tree. A full
   * refresh re-walks (cheap) and re-extracts only changed files, so the safe
   * move is to always refresh rather than trust a mtime-only check that
   * cannot notice brand-new files.
   */
  async ensureWarm() {
    if (!this.enabled) return null;
    const t = this._now();
    if (this._lastSnapshot && t - this._lastFreshCheck < REFRESH_COOLDOWN_MS) {
      return this._lastSnapshot;
    }
    this._lastFreshCheck = t;
    try {
      const { snapshot } = refreshMap(this.root, { maxFiles: this.maxFiles, languages: this.languages });
      this._lastSnapshot = snapshot;
      return snapshot;
    } catch {
      return this._lastSnapshot;
    }
  }

  /**
   * The inline context-packet section for a run, or null when the map is off,
   * empty, or the workspace refused to cooperate.
   *
   * @param {{ query?: string, focus?: string[], maxTokens?: number }} [options]
   */
  extraFor({ query = "", focus = [], maxTokens } = {}) {
    if (!this.enabled) return null;
    try {
      const map = this._lastSnapshot ?? loadMap(this.root);
      if (!map || !map.files?.length) return null;
      return formatRepoMapForPrompt(map, {
        maxTokens: maxTokens ?? this.maxTokens,
        focusFiles: focus,
        query,
      });
    } catch {
      return null;
    }
  }

  /**
   * The `repo-map` tool definition in the runtime's internal tool shape. READ
   * scope: the map derives from the file tree and reveals nothing the agent
   * could not read anyway.
   */
  toolDefinition() {
    return {
      name: "repo-map",
      scope: TOOL_SCOPE.READ,
      description:
        "Ranked structural map of the workspace: files ordered by PageRank over " +
        "the import graph, with each file's top symbols. Pass a query to boost " +
        "files matching your current concern.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords to boost matching files" },
          focus: { type: "array", items: { type: "string" }, description: "file paths to prioritise" },
          maxTokens: { type: "number", description: "output budget, default 2000" },
        },
      },
      resultSchema: { type: "object" },
      failureBehavior: { TOOL_ERROR: "error" },
      limits: {},
      redaction: "None: output is derived from file paths and symbol names.",
      events: ["tool.call", "tool.error"],
      /** @param {{ query?: string, focus?: string[], maxTokens?: number }} [args] */
      execute: async (args = {}) => {
        await this.ensureWarm();
        const text = this.extraFor({
          query: typeof args.query === "string" ? args.query : "",
          focus: Array.isArray(args.focus) ? args.focus : [],
          maxTokens: args.maxTokens,
        });
        if (text === null) {
          return { text: "repository map unavailable (not built or empty workspace)" };
        }
        return { text, raw: { query: args.query ?? "", focus: args.focus ?? [] } };
      },
    };
  }

  /** Register the tool onto a runtime's tool map. @returns {number} 1 when registered */
  registerTools(runtime) {
    if (!runtime?.tools?.set) return 0;
    runtime.tools.set("repo-map", this.toolDefinition());
    return 1;
  }
}

/**
 * Convenience factory used by chat/CLI wiring: null when the map is disabled.
 */
export function createRepoMapBridge(root, config) {
  const bridge = new RepoMapAgentBridge({ root, config });
  return bridge.enabled ? bridge : null;
}

export default { RepoMapAgentBridge, createRepoMapBridge };
