export default {
  id: "moonshot-pro",
  priority: 87,
  alias: "moon-pro",
  display: {
    name: "Moonshot Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "MSP",
    website: "https://api.moonshot.cn/v1",
    notice: {
      apiKeyUrl: "https://api.moonshot.cn/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.moonshot.cn/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "moonshot-pro-model-1", name: "Moonshot Pro Model 1" },
    { id: "moonshot-pro-model-2", name: "Moonshot Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
