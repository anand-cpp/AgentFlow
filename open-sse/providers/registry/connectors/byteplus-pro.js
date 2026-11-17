export default {
  id: "byteplus-pro",
  priority: 86,
  alias: "bp-pro",
  display: {
    name: "BytePlus Pro",
    icon: "smart_toy",
    color: "#FE2C55",
    textIcon: "BPP",
    website: "https://ark.byteplus.com/api/v3",
    notice: {
      apiKeyUrl: "https://ark.byteplus.com/api/v3/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://ark.byteplus.com/api/v3",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "byteplus-pro-model-1", name: "BytePlus Pro Model 1" },
    { id: "byteplus-pro-model-2", name: "BytePlus Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
