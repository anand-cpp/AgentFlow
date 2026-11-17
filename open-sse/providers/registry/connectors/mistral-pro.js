export default {
  id: "mistral-pro",
  priority: 81,
  alias: "mistral-pro",
  display: {
    name: "Mistral Pro",
    icon: "smart_toy",
    color: "#F63939",
    textIcon: "MP",
    website: "https://api.mistral.ai/v1",
    notice: {
      apiKeyUrl: "https://api.mistral.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.mistral.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "mistral-pro-model-1", name: "Mistral Pro Model 1" },
    { id: "mistral-pro-model-2", name: "Mistral Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
