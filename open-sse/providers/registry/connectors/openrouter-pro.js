export default {
  id: "openrouter-pro",
  priority: 70,
  alias: "or-pro",
  display: {
    name: "OpenRouter Pro",
    icon: "smart_toy",
    color: "#0D1117",
    textIcon: "ORP",
    website: "https://openrouter.ai/api/v1",
    notice: {
      apiKeyUrl: "https://openrouter.ai/api/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://openrouter.ai/api/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "openrouter-pro-model-1", name: "OpenRouter Pro Model 1" },
    { id: "openrouter-pro-model-2", name: "OpenRouter Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
