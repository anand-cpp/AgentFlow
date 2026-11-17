export default {
  id: "anthropic-cloud",
  priority: 65,
  alias: "anthropic-cloud",
  display: {
    name: "Anthropic Cloud",
    icon: "smart_toy",
    color: "#D97757",
    textIcon: "AN",
    website: "https://api.anthropic.com/v1",
    notice: {
      apiKeyUrl: "https://api.anthropic.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.anthropic.com/v1",
    format: "claude",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "anthropic-cloud-model-1", name: "Anthropic Cloud Model 1" },
    { id: "anthropic-cloud-model-2", name: "Anthropic Cloud Model 2" },
  ],
  serviceKinds: ["llm"],
};
