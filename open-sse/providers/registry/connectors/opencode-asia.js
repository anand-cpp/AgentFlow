export default {
  id: "opencode-asia",
  priority: 57,
  alias: "oc-asia",
  display: {
    name: "OpenCode Asia",
    icon: "smart_toy",
    color: "#E87040",
    textIcon: "OCA",
    website: "https://asia.api.opencode.ai/v1",
    notice: {
      apiKeyUrl: "https://asia.api.opencode.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://asia.api.opencode.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "opencode-asia-model-1", name: "OpenCode Asia Model 1" },
    { id: "opencode-asia-model-2", name: "OpenCode Asia Model 2" },
  ],
  serviceKinds: ["llm"],
};
