export default {
  id: "black-forest-labs-pro",
  priority: 97,
  alias: "bfl-pro",
  display: {
    name: "Black Forest Labs Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "BFP",
    website: "https://api.bfl.museum/v1",
    notice: {
      apiKeyUrl: "https://api.bfl.museum/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.bfl.museum/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "black-forest-labs-pro-model-1", name: "Black Forest Labs Pro Model 1" },
    { id: "black-forest-labs-pro-model-2", name: "Black Forest Labs Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
