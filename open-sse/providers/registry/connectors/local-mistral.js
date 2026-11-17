export default {
  id: "local-mistral",
  priority: 54,
  alias: "mistral-local",
  display: {
    name: "Local Mistral",
    icon: "smart_toy",
    color: "#DC2626",
    textIcon: "MS",
    website: "http://localhost:11436/v1",
    notice: {
      apiKeyUrl: "http://localhost:11436/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:11436/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "local-mistral-model-1", name: "Local Mistral Model 1" },
    { id: "local-mistral-model-2", name: "Local Mistral Model 2" },
  ],
  serviceKinds: ["llm"],
};
