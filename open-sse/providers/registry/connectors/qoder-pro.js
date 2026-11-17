export default {
  id: "qoder-pro",
  priority: 114,
  alias: "qoder-pro",
  display: {
    name: "Qoder Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "QDP",
    website: "https://api.qoder.ai/v1",
    notice: {
      apiKeyUrl: "https://api.qoder.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.qoder.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "qoder-pro-model-1", name: "Qoder Pro Model 1" },
    { id: "qoder-pro-model-2", name: "Qoder Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
