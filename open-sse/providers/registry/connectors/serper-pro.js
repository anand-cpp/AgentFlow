export default {
  id: "serper-pro",
  priority: 104,
  alias: "serper-pro",
  display: {
    name: "Serper Pro",
    icon: "smart_toy",
    color: "#FF6B00",
    textIcon: "SERP",
    website: "https://google.serper.dev",
    notice: {
      apiKeyUrl: "https://google.serper.dev/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://google.serper.dev",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "serper-pro-model-1", name: "Serper Pro Model 1" },
    { id: "serper-pro-model-2", name: "Serper Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
