export default {
  id: "local-qwen",
  priority: 51,
  alias: "qwen-local",
  display: {
    name: "Local Qwen",
    icon: "smart_toy",
    color: "#5B21B6",
    textIcon: "QW",
    website: "http://localhost:8000/v1",
    notice: {
      apiKeyUrl: "http://localhost:8000/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:8000/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "local-qwen-model-1", name: "Local Qwen Model 1" },
    { id: "local-qwen-model-2", name: "Local Qwen Model 2" },
  ],
  serviceKinds: ["llm"],
};
