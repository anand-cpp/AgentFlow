export default {
  id: "replicate-image",
  priority: 100,
  alias: "rp-img",
  display: {
    name: "Replicate Image",
    icon: "smart_toy",
    color: "#FF0080",
    textIcon: "RPI",
    website: "https://api.replicate.com/v1",
    notice: {
      apiKeyUrl: "https://api.replicate.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://api.replicate.com/v1",
    format: "replicate",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "replicate-image-model-1", name: "Replicate Image Model 1" },
    { id: "replicate-image-model-2", name: "Replicate Image Model 2" },
  ],
  serviceKinds: ["llm"],
};
