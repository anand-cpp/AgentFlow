export default {
  id: "baichuan-pro",
  priority: 88,
  alias: "bai-pro",
  display: {
    name: "Baichuan Pro",
    icon: "smart_toy",
    color: "#0066FF",
    textIcon: "BAP",
    website: "https://api.baichuan-ai.com/v1",
    notice: {
      apiKeyUrl: "https://api.baichuan-ai.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.baichuan-ai.com/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "baichuan-pro-model-1", name: "Baichuan Pro Model 1" },
    { id: "baichuan-pro-model-2", name: "Baichuan Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
