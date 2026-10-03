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

export default { defineCommand, getCommand, getCommands, commandNames };