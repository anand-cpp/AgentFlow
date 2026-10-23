// esm-plugin -- the trusted ESM fixture.
//
// ESM plugins cannot be evaluated in the vm sandbox the CommonJS path uses, so
// they load through dynamic `import()`: same trust decision as installing the
// package, same fail-isolation around the call, no sandbox in between. This
// fixture exists to prove the format is detected from the manifest's `main`
// extension and routed correctly.

export default function activate(context) {
  context.registerTool({
    name: "ping",
    description: "Answer with a sentinel the tests can assert.",
    scope: "read",
    schema: { type: "object", properties: {} },
    execute: async () => ({ pong: "ESM-PLUGIN-PONG" }),
  });
}
