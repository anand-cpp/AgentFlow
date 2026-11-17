export default {
  id: "fireworks-pro",
  priority: 73,
  alias: "fw-pro",
  display: {
    name: "Fireworks Pro",
    icon: "smart_toy",
    color: "#F90",
    textIcon: "FWP",
    website: "https://api.fireworks.ai/inference/v1",
    notice: {
      apiKeyUrl: "https://api.fireworks.ai/inference/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "fireworks-pro-model-1", name: "Fireworks Pro Model 1" },
    { id: "fireworks-pro-model-2", name: "Fireworks Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
