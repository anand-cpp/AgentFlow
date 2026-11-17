export default {
  id: "corporate-gateway",
  priority: 108,
  alias: "corp-gw",
  display: {
    name: "Corporate Gateway",
    icon: "smart_toy",
    color: "#374151",
    textIcon: "CGW",
    website: "https://gateway.corporate.internal/v1",
    notice: {
      apiKeyUrl: "https://gateway.corporate.internal/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://gateway.corporate.internal/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "corporate-gateway-model-1", name: "Corporate Gateway Model 1" },
    { id: "corporate-gateway-model-2", name: "Corporate Gateway Model 2" },
  ],
  serviceKinds: ["llm"],
};
