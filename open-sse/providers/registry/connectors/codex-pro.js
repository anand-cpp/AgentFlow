export default {
  id: "codex-pro",
  priority: 109,
  alias: "codex-pro",
  display: {
    name: "Codex Pro",
    icon: "smart_toy",
    color: "#10A37F",
    textIcon: "CXP",
    website: "https://api.openai.com/v1",
    notice: {
      apiKeyUrl: "https://api.openai.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.openai.com/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "codex-pro-model-1", name: "Codex Pro Model 1" },
    { id: "codex-pro-model-2", name: "Codex Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
