export default {
  id: "local-llama",
  priority: 50,
  alias: "llama",
  display: {
    name: "Local Llama",
    icon: "smart_toy",
    color: "#FB923C",
    textIcon: "LL",
    website: "http://localhost:11434/v1",
    notice: {
      apiKeyUrl: "http://localhost:11434/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:11434/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "local-llama-model-1", name: "Local Llama Model 1" },
    { id: "local-llama-model-2", name: "Local Llama Model 2" },
  ],
  serviceKinds: ["llm"],
};
