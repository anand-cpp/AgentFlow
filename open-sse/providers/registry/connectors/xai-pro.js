export default {
  id: "xai-pro",
  priority: 82,
  alias: "xai-pro",
  display: {
    name: "xAI Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "XAP",
    website: "https://api.x.ai/v1",
    notice: {
      apiKeyUrl: "https://api.x.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.x.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "xai-pro-model-1", name: "xAI Pro Model 1" },
    { id: "xai-pro-model-2", name: "xAI Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
