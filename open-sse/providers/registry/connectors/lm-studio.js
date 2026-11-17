export default {
  id: "lm-studio",
  priority: 116,
  alias: "lm-studio",
  display: {
    name: "LM Studio",
    icon: "smart_toy",
    color: "#FB923C",
    textIcon: "LMS",
    website: "http://localhost:1234/v1",
    notice: {
      apiKeyUrl: "http://localhost:1234/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:1234/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "lm-studio-model-1", name: "LM Studio Model 1" },
    { id: "lm-studio-model-2", name: "LM Studio Model 2" },
  ],
  serviceKinds: ["llm"],
};
