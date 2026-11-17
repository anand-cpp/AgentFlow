export default {
  id: "kilocode-eu",
  priority: 59,
  alias: "kc-eu",
  display: {
    name: "Kilo Code EU",
    icon: "smart_toy",
    color: "#FF6B35",
    textIcon: "KCE",
    website: "https://eu.api.kilo.ai/v1",
    notice: {
      apiKeyUrl: "https://eu.api.kilo.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://eu.api.kilo.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "kilocode-eu-model-1", name: "Kilo Code EU Model 1" },
    { id: "kilocode-eu-model-2", name: "Kilo Code EU Model 2" },
  ],
  serviceKinds: ["llm"],
};
