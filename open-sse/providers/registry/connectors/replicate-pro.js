export default {
  id: "replicate-pro",
  priority: 83,
  alias: "rp-pro",
  display: {
    name: "Replicate Pro",
    icon: "smart_toy",
    color: "#FF0080",
    textIcon: "RPP",
    website: "https://api.replicate.com/v1",
    notice: {
      apiKeyUrl: "https://api.replicate.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.replicate.com/v1",
    format: "replicate",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "replicate-pro-model-1", name: "Replicate Pro Model 1" },
    { id: "replicate-pro-model-2", name: "Replicate Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
