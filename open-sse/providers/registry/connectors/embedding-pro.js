export default {
  id: "embedding-pro",
  priority: 96,
  alias: "embed-pro",
  display: {
    name: "Embedding Pro",
    icon: "smart_toy",
    color: "#6366F1",
    textIcon: "EP",
    website: "https://api.embed-pro.com/v1",
    notice: {
      apiKeyUrl: "https://api.embed-pro.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.embed-pro.com/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "embedding-pro-model-1", name: "Embedding Pro Model 1" },
    { id: "embedding-pro-model-2", name: "Embedding Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
