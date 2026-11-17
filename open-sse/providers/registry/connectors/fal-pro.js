export default {
  id: "fal-pro",
  priority: 84,
  alias: "fal-pro",
  display: {
    name: "Fal Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "FPP",
    website: "https://fal.run/api",
    notice: {
      apiKeyUrl: "https://fal.run/api/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://fal.run/api",
    format: "fal",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "fal-pro-model-1", name: "Fal Pro Model 1" },
    { id: "fal-pro-model-2", name: "Fal Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
