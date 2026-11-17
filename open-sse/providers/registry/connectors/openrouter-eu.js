export default {
  id: "openrouter-eu",
  priority: 71,
  alias: "or-eu",
  display: {
    name: "OpenRouter EU",
    icon: "smart_toy",
    color: "#0D1117",
    textIcon: "ORE",
    website: "https://eu.openrouter.ai/api/v1",
    notice: {
      apiKeyUrl: "https://eu.openrouter.ai/api/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://eu.openrouter.ai/api/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "openrouter-eu-model-1", name: "OpenRouter EU Model 1" },
    { id: "openrouter-eu-model-2", name: "OpenRouter EU Model 2" },
  ],
  serviceKinds: ["llm"],
};
