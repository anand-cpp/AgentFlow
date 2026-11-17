export default {
  id: "exa-pro",
  priority: 102,
  alias: "exa-pro",
  display: {
    name: "Exa Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "EXP",
    website: "https://api.exa.ai",
    notice: {
      apiKeyUrl: "https://api.exa.ai/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.exa.ai",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "exa-pro-model-1", name: "Exa Pro Model 1" },
    { id: "exa-pro-model-2", name: "Exa Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
