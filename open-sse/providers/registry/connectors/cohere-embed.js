export default {
  id: "cohere-embed",
  priority: 94,
  alias: "cohere-embed",
  display: {
    name: "Cohere Embed",
    icon: "smart_toy",
    color: "#D81B60",
    textIcon: "CHE",
    website: "https://api.cohere.ai/v1",
    notice: {
      apiKeyUrl: "https://api.cohere.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.cohere.ai/v1",
    format: "cohere",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "cohere-embed-model-1", name: "Cohere Embed Model 1" },
    { id: "cohere-embed-model-2", name: "Cohere Embed Model 2" },
  ],
  serviceKinds: ["llm"],
};
