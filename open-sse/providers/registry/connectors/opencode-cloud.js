export default {
  id: "opencode-cloud",
  priority: 55,
  alias: "oc-cloud",
  display: {
    name: "OpenCode Cloud",
    icon: "smart_toy",
    color: "#E87040",
    textIcon: "OCC",
    website: "https://api.opencode.ai/v1",
    notice: {
      apiKeyUrl: "https://api.opencode.ai/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.opencode.ai/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "opencode-cloud-model-1", name: "OpenCode Cloud Model 1" },
    { id: "opencode-cloud-model-2", name: "OpenCode Cloud Model 2" },
  ],
  serviceKinds: ["llm"],
};
