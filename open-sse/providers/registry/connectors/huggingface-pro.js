export default {
  id: "huggingface-pro",
  priority: 78,
  alias: "hf-pro",
  display: {
    name: "HuggingFace Pro",
    icon: "smart_toy",
    color: "#FFD21E",
    textIcon: "HFP",
    website: "https://api-inference.huggingface.co",
    notice: {
      apiKeyUrl: "https://api-inference.huggingface.co/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api-inference.huggingface.co",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "huggingface-pro-model-1", name: "HuggingFace Pro Model 1" },
    { id: "huggingface-pro-model-2", name: "HuggingFace Pro Model 2" },
  ],
  serviceKinds: ["llm"],
};
