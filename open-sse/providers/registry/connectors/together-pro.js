export default {
  id: "together-pro",
  priority: 72,
  alias: "together-pro",
  display: {
    name: "Together Pro",
    icon: "smart_toy",
    color: "#060606",
    textIcon: "TP",
    website: "https://api.together.xyz/v1",
    notice: {
      apiKeyUrl: "https://api.together.xyz/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.together.xyz/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "together-pro-model-1", name: "Together Pro Model 1" },
    { id: "together-pro-model-2", name: "Together Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
