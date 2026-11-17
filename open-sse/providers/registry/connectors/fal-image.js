export default {
  id: "fal-image",
  priority: 99,
  alias: "fal-img",
  display: {
    name: "Fal Image",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "FAI",
    website: "https://fal.run/api",
    notice: {
      apiKeyUrl: "https://fal.run/api/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://fal.run/api",
    format: "fal",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "fal-image-model-1", name: "Fal Image Model 1" },
    { id: "fal-image-model-2", name: "Fal Image Model 2" },
  ],
  serviceKinds: ["llm"],
};
