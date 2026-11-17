export default {
  id: "stability-pro",
  priority: 98,
  alias: "stability-pro",
  display: {
    name: "Stability Pro",
    icon: "smart_toy",
    color: "#FF6B00",
    textIcon: "SP",
    website: "https://api.stability.ai/v1",
    notice: {
      apiKeyUrl: "https://api.stability.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.stability.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "stability-pro-model-1", name: "Stability Pro Model 1" },
    { id: "stability-pro-model-2", name: "Stability Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
