export default {
  id: "hyperbolic-pro",
  priority: 76,
  alias: "hyp-pro",
  display: {
    name: "Hyperbolic Pro",
    icon: "smart_toy",
    color: "#7C3AED",
    textIcon: "HPP",
    website: "https://api.hyperbolic.xyz/v1",
    notice: {
      apiKeyUrl: "https://api.hyperbolic.xyz/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.hyperbolic.xyz/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "hyperbolic-pro-model-1", name: "Hyperbolic Pro Model 1" },
    { id: "hyperbolic-pro-model-2", name: "Hyperbolic Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
