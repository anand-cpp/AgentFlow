export default {
  id: "jina-ai-embed",
  priority: 95,
  alias: "jina-embed",
  display: {
    name: "Jina AI Embed",
    icon: "smart_toy",
    color: "#FF0000",
    textIcon: "JAE",
    website: "https://ai.jina.ai/v1",
    notice: {
      apiKeyUrl: "https://ai.jina.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://ai.jina.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "jina-ai-embed-model-1", name: "Jina AI Embed Model 1" },
    { id: "jina-ai-embed-model-2", name: "Jina AI Embed Model 2" },
  ],
  serviceKinds: ["llm"],
};
