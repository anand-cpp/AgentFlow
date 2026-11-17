export default {
  id: "koboldcpp",
  priority: 119,
  alias: "kobold",
  display: {
    name: "KoboldCPP",
    icon: "smart_toy",
    color: "#FB923C",
    textIcon: "KBD",
    website: "http://localhost:5001/v1",
    notice: {
      apiKeyUrl: "http://localhost:5001/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:5001/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "koboldcpp-model-1", name: "KoboldCPP Model 1" },
    { id: "koboldcpp-model-2", name: "KoboldCPP Model 2" },
  ],
  serviceKinds: ["llm"],
};
