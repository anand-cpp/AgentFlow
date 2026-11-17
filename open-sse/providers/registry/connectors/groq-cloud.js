export default {
  id: "groq-cloud",
  priority: 66,
  alias: "groq-cloud",
  display: {
    name: "Groq Cloud",
    icon: "smart_toy",
    color: "#FAB005",
    textIcon: "GQC",
    website: "https://api.groq.com/openai/v1",
    notice: {
      apiKeyUrl: "https://api.groq.com/openai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.groq.com/openai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "groq-cloud-model-1", name: "Groq Cloud Model 1" },
    { id: "groq-cloud-model-2", name: "Groq Cloud Model 2" },
  ],
  serviceKinds: ["llm"],
};
