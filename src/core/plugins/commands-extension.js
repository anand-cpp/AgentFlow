// Plugin slash commands.
//
// The extension point behind `context.registerSlashCommand({ name,
// description, handler })`. A plugin command is callable as `/name arg` in
// the chat surface and executes with the same failure isolation as every
// other hook: a throwing handler becomes a rendered error, never a crash,
// and runs under a timeout so `/command` slang from a stuck plugin cannot
// freeze the read-eval loop.
//
// Namespacing is minimal here by design: after lowercasing, a plugin command
// named `todos` is simply `/todos`. Collisions are prevented at registration
// time -- builtin command names and anything already registered are refused,
// so no plugin command can intercept `/quit`, `/model`, `/mcp`, `/map`, etc.

const COMMAND_NAME_RE = /^[a-z0-9]{1,24}$/;
// A plugin registering this many commands is no longer a command set; it is
// a second help page nobody asked for.
export const MAX_COMMANDS_PER_PLUGIN = 16;

export function validateCommandDef(def, taken) {
  const errors = [];
  if (!def || typeof def !== "object") {
    return ["registerSlashCommand: definition must be an object"];
  }
  if (typeof def.name !== "string" || !COMMAND_NAME_RE.test(def.name)) {
    errors.push(`registerSlashCommand: name must match ${COMMAND_NAME_RE.source} (lowercase alphanumerics, max 24 chars)`);
  } else if (taken.has(def.name)) {
    errors.push(`registerSlashCommand: "/${def.name}" is already taken (builtin or registered earlier)`);
  }
  if (typeof def.description !== "string" || def.description.trim() === "") {
    errors.push("registerSlashCommand: description is required");
  }
  if (typeof def.handler !== "function") {
    errors.push("registerSlashCommand: handler must be a function");
  }
  return errors;
}

export class PluginCommandRegistry {
  constructor({ timeoutMs = 3000 } = {}) {
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, {pluginId: string, def: object}>} name -> entry */
    this.byName = new Map();
    this.byPlugin = new Map();
  }

  /**
   * @param {string} pluginId
   * @param {{ name: string, description: string, handler: Function }} def
   * @param {{ builtinNames?: string[] }} [opts] builtin names that must stay
   *   reserved even before any registration.
   */
  register(pluginId, def, { builtinNames = [] } = {}) {
    const err = validateCommandDef(def, new Set([...this.byName.keys(), ...builtinNames]));
    if (err.length > 0) return { ok: false, error: err[0], errors: err };

    const owned = this.byPlugin.get(pluginId) ?? [];
    if (owned.length >= MAX_COMMANDS_PER_PLUGIN) {
      return {
        ok: false,
        error: `registerSlashCommand: plugin "${pluginId}" hit the ${MAX_COMMANDS_PER_PLUGIN}-command cap`,
      };
    }
    const entry = { pluginId, def: { ...def, name: def.name.toLowerCase() } };
    this.byName.set(def.name.toLowerCase(), entry);
    this.byPlugin.set(pluginId, [...owned, entry.def.name]);
    return { ok: true, name: entry.def.name };
  }

  get(name) {
    return this.byName.get(String(name ?? "").toLowerCase());
  }

  has(name) {
    return this.byName.has(String(name ?? "").toLowerCase());
  }

  /** Sorted command listing for help text: `/name -- pluginId -- description`. */
  list() {
    return [...this.byName.values()]
      .map((e) => ({ name: e.def.name, pluginId: e.pluginId, description: e.def.description }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  commandsForPlugin(pluginId) {
    return (this.byPlugin.get(pluginId) ?? []).map((n) => this.byName.get(n));
  }

  removePlugin(pluginId) {
    const names = this.byPlugin.get(pluginId) ?? [];
    for (const n of names) this.byName.delete(n);
    this.byPlugin.delete(pluginId);
    return names.length;
  }

  get size() {
    return this.byName.size;
  }
}

/**
 * Execute a plugin command under fail isolation.
 *
 * @param {PluginCommandRegistry} registry
 * @param {string} name command name (no slash)
 * @param {string} arg everything after the slash command
 * @param {object} session the chat session handle given to the handler
 * @returns {{ ok: boolean, kind: "plugin", text: string, data?: object, isHelp?: boolean }}
 *   Never throws; handler errors become rendered text in `text`.
 */
export async function runPluginCommand(registry, name, arg, session) {
  const entry = registry?.get(name);
  if (!entry) {
    return { ok: false, kind: "plugin", text: `unknown command: /${name}` };
  }
  const call = `plugin command "${entry.pluginId}": /${entry.def.name}`;
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${call} timed out after ${registry.timeoutMs}ms`)), registry.timeoutMs);
    });
    const result = await Promise.race([Promise.resolve(entry.def.handler(arg, session)), timeout]);
    clearTimeout(timer);
    const text = result && typeof result === "object" && typeof result.text === "string" ? result.text : String(result ?? "");
    return {
      ok: true,
      kind: "plugin",
      text,
      data: result && typeof result === "object" && result.data && typeof result.data === "object" ? result.data : undefined,
    };
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, kind: "plugin", text: `${call}: ${error?.message ?? String(error)}` };
  }
}
