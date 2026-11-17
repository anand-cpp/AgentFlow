export default {
  id: "trae-pro",
  priority: 113,
  alias: "trae-pro",
  display: {
    name: "Trae Pro",
    icon: "smart_toy",
    color: "#FF6B35",
    textIcon: "TRP",
    website: "https://api.trae.ai/v1",
    notice: {
      apiKeyUrl: "https://api.trae.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.trae.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "trae-pro-model-1", name: "Trae Pro Model 1" },
    { id: "trae-pro-model-2", name: "Trae Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
