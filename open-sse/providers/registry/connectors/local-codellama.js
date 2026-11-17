export default {
  id: "local-codellama",
  priority: 53,
  alias: "codellama-local",
  display: {
    name: "Local CodeLlama",
    icon: "smart_toy",
    color: "#166534",
    textIcon: "CL",
    website: "http://localhost:11435/v1",
    notice: {
      apiKeyUrl: "http://localhost:11435/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:11435/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "local-codellama-model-1", name: "Local CodeLlama Model 1" },
    { id: "local-codellama-model-2", name: "Local CodeLlama Model 2" },
  ],
  serviceKinds: ["llm"],
};
