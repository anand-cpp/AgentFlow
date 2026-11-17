export default {
  id: "llama-cpp-server",
  priority: 117,
  alias: "llama-cpp",
  display: {
    name: "llama.cpp Server",
    icon: "smart_toy",
    color: "#FB923C",
    textIcon: "LCS",
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
    { id: "llama-cpp-server-model-1", name: "llama.cpp Server Model 1" },
    { id: "llama-cpp-server-model-2", name: "llama.cpp Server Model 2" },
  ],
  serviceKinds: ["llm"],
};
