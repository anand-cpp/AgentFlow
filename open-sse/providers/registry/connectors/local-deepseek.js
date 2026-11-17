export default {
  id: "local-deepseek",
  priority: 52,
  alias: "deepseek-local",
  display: {
    name: "Local DeepSeek",
    icon: "smart_toy",
    color: "#FE6D87",
    textIcon: "DS",
    website: "http://localhost:8080/v1",
    notice: {
      apiKeyUrl: "http://localhost:8080/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:8080/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "local-deepseek-model-1", name: "Local DeepSeek Model 1" },
    { id: "local-deepseek-model-2", name: "Local DeepSeek Model 2" },
  ],
  serviceKinds: ["llm"],
};
