export default {
  id: "zed-pro",
  priority: 112,
  alias: "zed-pro",
  display: {
    name: "Zed Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "ZDP",
    website: "https://api.zed.dev/v1",
    notice: {
      apiKeyUrl: "https://api.zed.dev/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.zed.dev/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "zed-pro-model-1", name: "Zed Pro Model 1" },
    { id: "zed-pro-model-2", name: "Zed Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
