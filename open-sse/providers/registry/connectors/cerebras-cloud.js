export default {
  id: "cerebras-cloud",
  priority: 67,
  alias: "cerebras-cloud",
  display: {
    name: "Cerebras Cloud",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "CRC",
    website: "https://api.cerebras.ai/v1",
    notice: {
      apiKeyUrl: "https://api.cerebras.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.cerebras.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "cerebras-cloud-model-1", name: "Cerebras Cloud Model 1" },
    { id: "cerebras-cloud-model-2", name: "Cerebras Cloud Model 2" },
  ],
  serviceKinds: ["llm"],
};
