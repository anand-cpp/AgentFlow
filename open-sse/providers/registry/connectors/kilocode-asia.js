export default {
  id: "kilocode-asia",
  priority: 60,
  alias: "kc-asia",
  display: {
    name: "Kilo Code Asia",
    icon: "smart_toy",
    color: "#FF6B35",
    textIcon: "KCA",
    website: "https://asia.api.kilo.ai/v1",
    notice: {
      apiKeyUrl: "https://asia.api.kilo.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://asia.api.kilo.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "kilocode-asia-model-1", name: "Kilo Code Asia Model 1" },
    { id: "kilocode-asia-model-2", name: "Kilo Code Asia Model 2" },
  ],
  serviceKinds: ["llm"],
};
