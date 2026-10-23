// provider-plugin -- the provider-routing fixture.
//
// Registers one model provider with a streaming implementation. The runtime
// namespaces it to `plugin__provider-plugin__local/<model>`, so it can never
// shadow a builtin provider id.
//
// This fixture exists to pin a real defect: the chat engine used to install
// the dispatch wrapper's `streamComplete` by reading `.stream`, which is not
// a property of the wrapper. The assignment silently produced `undefined`, so
// the first streamed reply after any plugin registered a provider threw
// "this.stream is not a function". See the chat-provider test.

module.exports = function activate(context) {
  context.registerProvider({
    id: "local",
    name: "Local Fixture Provider",
    models: ["llama3", "mistral"],
    complete: async function () {
      return { model: "local", text: "FROM-PLUGIN-PROVIDER", usage: { total_tokens: 4 } };
    },
    streamComplete: async function (cfg, modelId, messages, opts) {
      const text = "FROM-PLUGIN-PROVIDER";
      if (opts && typeof opts.onToken === "function") {
        for (const ch of text) opts.onToken(ch);
      }
      return { model: modelId, text, streamed: true, usage: { total_tokens: text.length } };
    },
  });
};
