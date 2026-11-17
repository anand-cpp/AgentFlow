export default {
  id: "brave-search-pro",
  priority: 103,
  alias: "brave-pro",
  display: {
    name: "Brave Search Pro",
    icon: "smart_toy",
    color: "#FB542B",
    textIcon: "BSP",
    website: "https://api.search.brave.com/res/v1",
    notice: {
      apiKeyUrl: "https://api.search.brave.com/res/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.search.brave.com/res/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "brave-search-pro-model-1", name: "Brave Search Pro Model 1" },
    { id: "brave-search-pro-model-2", name: "Brave Search Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
