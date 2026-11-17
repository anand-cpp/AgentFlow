export default {
  id: "nebius-pro",
  priority: 75,
  alias: "nb-pro",
  display: {
    name: "Nebius Pro",
    icon: "smart_toy",
    color: "#6C5CE7",
    textIcon: "NBP",
    website: "https://api.nebius.ai/v1",
    notice: {
      apiKeyUrl: "https://api.nebius.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.nebius.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "nebius-pro-model-1", name: "Nebius Pro Model 1" },
    { id: "nebius-pro-model-2", name: "Nebius Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
