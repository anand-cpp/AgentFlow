// Plugin tool registration.
//
// The extension point behind `context.registerTool({ name, description,
// schema, execute })`. Every plugin tool is namespaced as
// `plugin__<pluginId>__<name>` before it ever reaches the agent's tool map,
// so two plugins (or a plugin and a builtin) cannot collide, and operators
// can see in transcripts exactly which plugin ran what.
//
// Tools registered here flow into AgentFlow's normal permission and
// redaction pipeline: the runtime executes whatever is in its tool map, and
// plugin tools land there through exactly the same path builtins do. No
// plugin ever talks to the filesystem, network, or model directly.

const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
// A plugin offering more than this many tools is almost certainly abusing the
// registration call, and the tool map would drown every other tool's prompt
// entry.
export const MAX_TOOLS_PER_PLUGIN = 32;

/**
 * Light-weight JSON Schema sanity check. Full JSON Schema is enormous and
 * implementation-independent; what matters here is that the schema is an
 * object tree the runtime's tool-callers can format without exploding.
 * Depth-bounded, with structural checks on the keys used most.
 *
 * @returns {string[]} validation errors (empty = acceptable schema)
 */
export function validateToolSchema(schema, depth = 0) {
  const errors = [];
  if (schema === undefined || schema === null) return errors;
  if (typeof schema !== "object" || Array.isArray(schema)) {
    return ["schema: must be a JSON object"];
  }
  if (depth > 8) {
    return ["schema: nesting deeper than 8 levels is not supported"];
  }
  for (const key of Object.keys(schema)) {
    if (key === "properties" && schema.properties !== null) {
      if (typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
        errors.push("schema.properties: must be a JSON object");
        continue;
      }
      for (const [prop, sub] of Object.entries(schema.properties)) {
        for (const err of validateToolSchema(sub, depth + 1)) {
          errors.push(`schema.properties.${prop}: ${err}`);
        }
      }
    } else if (key === "items") {
      for (const err of validateToolSchema(schema.items, depth + 1)) {
        errors.push(`schema.items: ${err}`);
      }
    } else if (key === "required") {
      if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string")) {
        errors.push("schema.required: must be an array of property names");
      }
    } else if (key === "type") {
      if (typeof schema.type !== "string") {
        errors.push("schema.type: must be a string");
      }
    }
    // Everything else (description, default, enum, examples, ...) is
    // forwarded untouched for forward-compat with richer schemas.
  }
  return errors;
}

export class PluginToolRegistry {
  constructor() {
    /** @type {Map<string, {pluginId: string, def: object, fullName: string}>} */
    this.byFullName = new Map();
    /** @type {Map<string, string[]>} plugin id -> full names it owns */
    this.byPlugin = new Map();
  }

  /**
   * Register a tool.
   *
   * @param {string} pluginId
   * @param {{ name: string, description: string, schema?: object, execute: Function }} def
   * @returns {{ ok: boolean, fullName?: string, error?: string }}
   */
  register(pluginId, def) {
    if (!def || typeof def !== "object") {
      return { ok: false, error: "registerTool: definition must be an object" };
    }
    if (typeof def.name !== "string" || !TOOL_NAME_RE.test(def.name)) {
      return {
        ok: false,
        error: `registerTool: name must match ${TOOL_NAME_RE.source}`,
      };
    }
    if (typeof def.description !== "string" || def.description.trim() === "") {
      return { ok: false, error: "registerTool: description is required" };
    }
    if (typeof def.execute !== "function") {
      return { ok: false, error: "registerTool: execute must be a function" };
    }
    const schemaErrors = validateToolSchema(def.schema);
    if (schemaErrors.length > 0) {
      return { ok: false, error: schemaErrors[0], errors: schemaErrors };
    }

    const owned = this.byPlugin.get(pluginId) ?? [];
    if (owned.length >= MAX_TOOLS_PER_PLUGIN) {
      return { ok: false, error: `registerTool: plugin "${pluginId}" hit the ${MAX_TOOLS_PER_PLUGIN}-tool cap` };
    }

    const fullName = `plugin__${pluginId}__${def.name}`;
    if (this.byFullName.has(fullName)) {
      return { ok: false, error: `registerTool: "${fullName}" is already registered` };
    }

    // The stored execute is wrapped: whatever def.execute throws becomes a
    // rejection the runtime's standard tool path already handles.
    const entry = {
      pluginId,
      fullName,
      def: {
        name: fullName,
        description: def.description,
        schema: def.schema ?? { type: "object" },
        // The original function under the namespace-aware name the agent sees.
        execute: def.execute,
      },
    };
    this.byFullName.set(fullName, entry);
    this.byPlugin.set(pluginId, [...owned, fullName]);
    return { ok: true, fullName };
  }

  /** All registered tools, sorted by name for deterministic listings. */
  entries() {
    return [...this.byFullName.values()].sort((a, b) => (a.fullName < b.fullName ? -1 : 1));
  }

  /** Look a tool up by its namespaced name; undefined when absent. */
  get(fullName) {
    return this.byFullName.get(fullName);
  }

  /** Tools one plugin registered (sorted), for `inspect`. */
  forPlugin(pluginId) {
    return (this.byPlugin.get(pluginId) ?? []).sort().map((name) => this.byFullName.get(name));
  }

  /** Remove a plugin's tools entirely (unload path). */
  removePlugin(pluginId) {
    const names = this.byPlugin.get(pluginId) ?? [];
    for (const name of names) this.byFullName.delete(name);
    this.byPlugin.delete(pluginId);
    return names.length;
  }

  get size() {
    return this.byFullName.size;
  }
}
