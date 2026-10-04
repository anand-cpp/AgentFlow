// Command registry.
//
// Split out from cli/index.js so commands can register themselves without
// importing the router back — the two were in a cycle, which ESM resolves
// badly ("Detected cycle while resolving name 'defineCommand'").

const COMMANDS = new Map();

export function defineCommand(name, spec) {
  if (COMMANDS.has(name)) throw new Error(`command already registered: ${name}`);
  COMMANDS.set(name, { name, ...spec });
  return COMMANDS.get(name);
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

/**
 * Union of every flag that takes a value, across all commands.
 *
 * The argv parser needs to know this *before* it has identified the command,
 * because deciding whether `--limit 4` consumes `4` requires the answer before
 * the scan reaches it. Taking the union is a deliberate over-approximation:
 * it can only make a flag consume a value that would otherwise be a stray
 * positional, never the reverse.
 *
 * The alternative — a two-pass parse that resolves the command first — breaks
 * on exactly the ambiguous input this exists to handle.
 */
export function valueFlagNames() {
  const out = new Set();
  for (const c of COMMANDS.values()) {
    for (const f of c.valueFlags || []) out.add(f);
  }
  return out;
}

export default { defineCommand, getCommand, getCommands, commandNames, valueFlagNames };