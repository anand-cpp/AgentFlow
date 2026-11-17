export default {
  id: "minimax-pro",
  priority: 85,
  alias: "mmx-pro",
  display: {
    name: "MiniMax Pro",
    icon: "smart_toy",
    color: "#10AE7D",
    textIcon: "MXP",
    website: "https://api.minimaxi.com/v1",
    notice: {
      apiKeyUrl: "https://api.minimaxi.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.minimaxi.com/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "minimax-pro-model-1", name: "MiniMax Pro Model 1" },
    { id: "minimax-pro-model-2", name: "MiniMax Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
