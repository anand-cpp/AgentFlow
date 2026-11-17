export default {
  id: "opencode-eu",
  priority: 56,
  alias: "oc-eu",
  display: {
    name: "OpenCode EU",
    icon: "smart_toy",
    color: "#E87040",
    textIcon: "OCE",
    website: "https://eu.api.opencode.ai/v1",
    notice: {
      apiKeyUrl: "https://eu.api.opencode.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://eu.api.opencode.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "opencode-eu-model-1", name: "OpenCode EU Model 1" },
    { id: "opencode-eu-model-2", name: "OpenCode EU Model 2" },
  ],
  serviceKinds: ["llm"],
};
