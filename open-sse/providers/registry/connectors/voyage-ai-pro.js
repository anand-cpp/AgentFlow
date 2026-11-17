export default {
  id: "voyage-ai-pro",
  priority: 93,
  alias: "voyage-pro",
  display: {
    name: "Voyage AI Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "VAP",
    website: "https://api.voyageai.com/v1",
    notice: {
      apiKeyUrl: "https://api.voyageai.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.voyageai.com/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "voyage-ai-pro-model-1", name: "Voyage AI Pro Model 1" },
    { id: "voyage-ai-pro-model-2", name: "Voyage AI Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
