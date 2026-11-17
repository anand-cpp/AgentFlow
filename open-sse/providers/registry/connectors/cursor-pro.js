export default {
  id: "cursor-pro",
  priority: 110,
  alias: "cursor-pro",
  display: {
    name: "Cursor Pro",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "CSP",
    website: "https://api.cursor.sh/v1",
    notice: {
      apiKeyUrl: "https://api.cursor.sh/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.cursor.sh/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "cursor-pro-model-1", name: "Cursor Pro Model 1" },
    { id: "cursor-pro-model-2", name: "Cursor Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
