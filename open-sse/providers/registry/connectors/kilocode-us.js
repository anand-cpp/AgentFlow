export default {
  id: "kilocode-us",
  priority: 58,
  alias: "kc-us",
  display: {
    name: "Kilo Code US",
    icon: "smart_toy",
    color: "#FF6B35",
    textIcon: "KCU",
    website: "https://api.kilo.ai/v1",
    notice: {
      apiKeyUrl: "https://api.kilo.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.kilo.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "kilocode-us-model-1", name: "Kilo Code US Model 1" },
    { id: "kilocode-us-model-2", name: "Kilo Code US Model 2" },
  ],
  serviceKinds: ["llm"],
};
