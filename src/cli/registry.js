// Command registry.
//
// Split out from cli/index.js so commands can register themselves without
// importing the router back -- the two were in a cycle, which ESM resolves
// badly ("Detected cycle while resolving name 'defineCommand'").
//
// Two registration tiers:
//
//   * defineCommandMeta(name, meta)   -- lightweight name/summary/valueFlags
//     only, no `run`. Registered eagerly by src/commands/index.js so that
//     `--help` and argv flag parsing never need to load heavy command modules.
//   * defineCommand(name, spec)       -- full spec including `run`, called by
//     each command module when it is (lazily) imported. Merges into a meta
//     entry that already exists, marking it loaded.
//
// Commands are loaded on demand via loadCommand(name), which dynamically
// imports src/commands/<name>.js -- that module self-registers through
// defineCommand and pulls in only the subsystems it actually needs (LSP, MCP,
// tribunal, PageRank, ...). Commands never invoked stay unloaded, keeping
// `aflow --version`, `--help`, and `status` fast.

const COMMANDS = new Map(); // name -> { name, summary, usage, valueFlags, run, loaded }

export function defineCommandMeta(name, meta) {
  if (COMMANDS.has(name)) throw new Error(`command already registered: ${name}`);
  COMMANDS.set(name, { name, loaded: false, run: undefined, ...meta });
  return COMMANDS.get(name);
}

export function defineCommand(name, spec) {
  const existing = COMMANDS.get(name);
  if (existing && existing.loaded) throw new Error(`command already registered: ${name}`);
  // Fill in `run` and mark loaded, preserving any meta already registered.
  COMMANDS.set(name, { ...existing, ...spec, name, loaded: true });
  return COMMANDS.get(name);
}

/** Load one command's module on demand. The module self-registers through
 *  defineCommand, so after this resolves getCommand(name) returns the full
 *  entry including `run`. Returns null when there is no such command. */
export async function loadCommand(name) {
  const entry = COMMANDS.get(name);
  if (entry?.loaded) return entry;
  if (!entry) return null; // unknown command -- nothing to load
  try {
    // Dynamic import is relative to this module (src/cli/registry.js).
    await import(`../commands/${name}.js`);
  } catch (err) {
    // A command module that fails to load is reported at dispatch time, not
    // here -- the caller decides how to surface it.
    return null;
  }
  return COMMANDS.get(name) || null;
}

export function getCommand(name) {
  return COMMANDS.get(name) || null;
}

export function getCommands() {
  return [...COMMANDS.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function commandNames() {
  return getCommands().map((c) => c.name);
}

/** Union of every flag that takes a value, across all commands. Read from
 *  metadata only -- no command modules are loaded. */
export function valueFlagNames() {
  const out = new Set();
  for (const c of COMMANDS.values()) {
    for (const f of c.valueFlags || []) out.add(f);
  }
  return out;
}

export default { defineCommand, defineCommandMeta, getCommand, getCommands, commandNames, valueFlagNames, loadCommand };
