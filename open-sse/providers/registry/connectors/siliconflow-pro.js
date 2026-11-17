export default {
  id: "siliconflow-pro",
  priority: 77,
  alias: "sf-pro",
  display: {
    name: "SiliconFlow Pro",
    icon: "smart_toy",
    color: "#00A2FF",
    textIcon: "SFP",
    website: "https://api.siliconflow.cn/v1",
    notice: {
      apiKeyUrl: "https://api.siliconflow.cn/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.siliconflow.cn/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "siliconflow-pro-model-1", name: "SiliconFlow Pro Model 1" },
    { id: "siliconflow-pro-model-2", name: "SiliconFlow Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
