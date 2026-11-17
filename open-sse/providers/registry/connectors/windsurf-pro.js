export default {
  id: "windsurf-pro",
  priority: 111,
  alias: "windsurf-pro",
  display: {
    name: "Windsurf Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "WSP",
    website: "https://api.windsurf.sh/v1",
    notice: {
      apiKeyUrl: "https://api.windsurf.sh/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.windsurf.sh/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "windsurf-pro-model-1", name: "Windsurf Pro Model 1" },
    { id: "windsurf-pro-model-2", name: "Windsurf Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
