export default {
  id: "text-gen-webui",
  priority: 118,
  alias: "tgw",
  display: {
    name: "Text Gen WebUI",
    icon: "smart_toy",
    color: "#FB923C",
    textIcon: "TGW",
    website: "http://localhost:5000/v1",
    notice: {
      apiKeyUrl: "http://localhost:5000/v1/keys",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
    noAuth: true,

  transport: {
    baseUrl: "http://localhost:5000/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "text-gen-webui-model-1", name: "Text Gen WebUI Model 1" },
    { id: "text-gen-webui-model-2", name: "Text Gen WebUI Model 2" },
  ],
  serviceKinds: ["llm"],
};
