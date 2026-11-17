export default {
  id: "ollama-proxy",
  priority: 115,
  alias: "ollama-proxy",
  display: {
    name: "Ollama Proxy",
    icon: "smart_toy",
    color: "#D51E3D",
    textIcon: "OLP",
    website: "http://localhost:11434/v1",
    notice: {
      apiKeyUrl: "http://localhost:11434/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:11434/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "ollama-proxy-model-1", name: "Ollama Proxy Model 1" },
    { id: "ollama-proxy-model-2", name: "Ollama Proxy Model 2" },
  ],
  serviceKinds: ["llm"],
};
