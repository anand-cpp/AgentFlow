export default {
  id: "cohere-pro",
  priority: 80,
  alias: "cohere-pro",
  display: {
    name: "Cohere Pro",
    icon: "smart_toy",
    color: "#D81B60",
    textIcon: "CHP",
    website: "https://api.cohere.ai/v1",
    notice: {
      apiKeyUrl: "https://api.cohere.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.cohere.ai/v1",
    format: "cohere",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "cohere-pro-model-1", name: "Cohere Pro Model 1" },
    { id: "cohere-pro-model-2", name: "Cohere Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
