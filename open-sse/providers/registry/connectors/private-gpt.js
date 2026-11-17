export default {
  id: "private-gpt",
  priority: 107,
  alias: "private-gpt",
  display: {
    name: "Private GPT",
    icon: "smart_toy",
    color: "#374151",
    textIcon: "PGPT",
    website: "http://localhost:8081/v1",
    notice: {
      apiKeyUrl: "http://localhost:8081/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:8081/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "private-gpt-model-1", name: "Private GPT Model 1" },
    { id: "private-gpt-model-2", name: "Private GPT Model 2" },
  ],
  serviceKinds: ["llm"],
};
