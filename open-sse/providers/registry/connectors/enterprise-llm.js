export default {
  id: "enterprise-llm",
  priority: 106,
  alias: "ent-llm",
  display: {
    name: "Enterprise LLM",
    icon: "smart_toy",
    color: "#374151",
    textIcon: "ELM",
    website: "https://api.enterprise-llm.internal/v1",
    notice: {
      apiKeyUrl: "https://api.enterprise-llm.internal/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.enterprise-llm.internal/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "enterprise-llm-model-1", name: "Enterprise LLM Model 1" },
    { id: "enterprise-llm-model-2", name: "Enterprise LLM Model 2" },
  ],
  serviceKinds: ["llm"],
};
