export default {
  id: "groq-enterprise",
  priority: 69,
  alias: "groq-ent",
  display: {
    name: "Groq Enterprise",
    icon: "smart_toy",
    color: "#FAB005",
    textIcon: "GQE",
    website: "https://enterprise.api.groq.com/openai/v1",
    notice: {
      apiKeyUrl: "https://enterprise.api.groq.com/openai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://enterprise.api.groq.com/openai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "groq-enterprise-model-1", name: "Groq Enterprise Model 1" },
    { id: "groq-enterprise-model-2", name: "Groq Enterprise Model 2" },
  ],
  serviceKinds: ["llm"],
};
