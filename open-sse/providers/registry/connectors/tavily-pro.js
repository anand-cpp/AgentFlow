export default {
  id: "tavily-pro",
  priority: 101,
  alias: "tavily-pro",
  display: {
    name: "Tavily Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "TVP",
    website: "https://api.tavily.com",
    notice: {
      apiKeyUrl: "https://api.tavily.com/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.tavily.com",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "tavily-pro-model-1", name: "Tavily Pro Model 1" },
    { id: "tavily-pro-model-2", name: "Tavily Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
