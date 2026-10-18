// sample-plugin -- the reference fixture.
//
// This is the plugin docs/PLUGINS.md walks through. It exercises every
// registration surface a sandboxed CJS plugin can reach, and deliberately
// touches nothing outside the sandbox: `require` is not used at all, because
// the loader only allows `node:events`.
//
// Each sentinel string below is asserted by the integration tests, so this
// file is the contract for what a plugin can actually do.

module.exports = function activate(context) {
  // Enrichment, not veto: returning `{ extra }` appends text to the context
  // packet the model sees. Returning `{ deny: true, reason }` would refuse the
  // run outright.
  context.on("beforeAgentRun", function (payload) {
    if (payload && payload.task && String(payload.task).includes("SKIP-SAMPLE")) {
      return { deny: true, reason: "sample-plugin declined: task asked to be skipped" };
    }
    return { extra: "SAMPLE-PLUGIN-EXTRA" };
  });

  // Observe a completed run. Returning nothing keeps this fire-and-forget: it
  // can never block or reshape the result. `context.log` is a per-plugin ring
  // with .info/.warn/.error, not a callable -- `aflow plugin inspect` prints it.
  context.on("afterAgentRun", function () {
    context.log.info("sample-plugin saw a run finish");
  });

  // Refuse one specific tool by name. This is a veto layered on top of the
  // permission model, never a substitute for it.
  context.on("beforeToolExecute", function (payload) {
    if (payload && payload.tool === "plugin__sample-plugin__guarded") {
      return { deny: true, reason: "sample-plugin guards that tool" };
    }
    return null;
  });

  // A read-scoped tool. The runtime namespaces it to plugin__sample-plugin__<name>,
  // so it can never collide with a builtin.
  context.registerTool({
    name: "remember",
    description: "Remember a short note and read it back.",
    scope: "read",
    schema: {
      type: "object",
      properties: { note: { type: "string", description: "The note to remember." } },
      required: ["note"],
    },
    execute: async function (args) {
      const note = args && args.note ? String(args.note) : "";
      return { remembered: "SAMPLE-PLUGIN-NOTE:" + note };
    },
  });

  // A context block. Budget admission happens in the manager: a block that
  // exceeds the remaining token budget is skipped, never silently truncated.
  context.registerContextProvider({
    name: "notes",
    description: "Standing notes the sample plugin wants in context.",
    getContext: async function () {
      return "sample-plugin notes: SAMPLE-PLUGIN-CONTEXT";
    },
  });

  // A slash command. The name is checked against the builtin reservation list
  // at registration time, so this cannot shadow /quit or /model.
  context.registerSlashCommand({
    name: "sample",
    description: "Show what the sample plugin registered.",
    handler: async function () {
      return "sample-plugin says hi: SAMPLE-PLUGIN-COMMAND";
    },
  });

  // A second tool the plugin refuses to run. Registering it and then vetoing
  // it is the pattern for "this capability exists but is off by default".
  context.registerTool({
    name: "guarded",
    description: "A tool this plugin refuses to execute.",
    scope: "read",
    schema: { type: "object", properties: {} },
    execute: async function () {
      return { unreachable: true };
    },
  });
};
