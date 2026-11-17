export default {
  id: "jina-reader-pro",
  priority: 105,
  alias: "jina-reader-pro",
  display: {
    name: "Jina Reader Pro",
    icon: "smart_toy",
    color: "#FF0000",
    textIcon: "JRP",
    website: "https://r.jina.ai",
    notice: {
      apiKeyUrl: "https://r.jina.ai/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://r.jina.ai",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "jina-reader-pro-model-1", name: "Jina Reader Pro Model 1" },
    { id: "jina-reader-pro-model-2", name: "Jina Reader Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
