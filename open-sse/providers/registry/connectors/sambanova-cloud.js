export default {
  id: "sambanova-cloud",
  priority: 68,
  alias: "samba-cloud",
  display: {
    name: "SambaNova Cloud",
    icon: "smart_toy",
    color: "#FD0054",
    textIcon: "SNC",
    website: "https://api.sambanova.ai/v1",
    notice: {
      apiKeyUrl: "https://api.sambanova.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.sambanova.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "sambanova-cloud-model-1", name: "SambaNova Cloud Model 1" },
    { id: "sambanova-cloud-model-2", name: "SambaNova Cloud Model 2" },
  ],
  serviceKinds: ["llm"],
};
