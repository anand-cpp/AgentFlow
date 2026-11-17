export default {
  id: "zhipu-pro",
  priority: 89,
  alias: "zhipu-pro",
  display: {
    name: "Zhipu AI Pro",
    icon: "smart_toy",
    color: "#FF6B00",
    textIcon: "ZPP",
    website: "https://open.bigmodel.cn/api/paas/v4",
    notice: {
      apiKeyUrl: "https://open.bigmodel.cn/api/paas/v4/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "zhipu-pro-model-1", name: "Zhipu AI Pro Model 1" },
    { id: "zhipu-pro-model-2", name: "Zhipu AI Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
