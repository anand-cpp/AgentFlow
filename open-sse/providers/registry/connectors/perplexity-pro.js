export default {
  id: "perplexity-pro",
  priority: 79,
  alias: "px-pro",
  display: {
    name: "Perplexity Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "PXP",
    website: "https://api.perplexity.ai",
    notice: {
      apiKeyUrl: "https://api.perplexity.ai/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.perplexity.ai",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "perplexity-pro-model-1", name: "Perplexity Pro Model 1" },
    { id: "perplexity-pro-model-2", name: "Perplexity Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
