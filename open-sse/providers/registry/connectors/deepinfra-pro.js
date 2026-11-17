export default {
  id: "deepinfra-pro",
  priority: 74,
  alias: "di-pro",
  display: {
    name: "DeepInfra Pro",
    icon: "smart_toy",
    color: "#6366F1",
    textIcon: "DIP",
    website: "https://api.deepinfra.com/v1/openai",
    notice: {
      apiKeyUrl: "https://api.deepinfra.com/v1/openai/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.deepinfra.com/v1/openai",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "deepinfra-pro-model-1", name: "DeepInfra Pro Model 1" },
    { id: "deepinfra-pro-model-2", name: "DeepInfra Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
