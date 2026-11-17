export default {
  id: "azure-openai",
  priority: 63,
  alias: "azure-aoai",
  display: {
    name: "Azure OpenAI",
    icon: "smart_toy",
    color: "#0089D6",
    textIcon: "AZ",
    website: "https://{resource}.openai.azure.com",
    notice: {
      apiKeyUrl: "https://{resource}.openai.azure.com/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://{resource}.openai.azure.com",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "azure-openai-model-1", name: "Azure OpenAI Model 1" },
    { id: "azure-openai-model-2", name: "Azure OpenAI Model 2" },
  ],
  serviceKinds: ["llm"],
};
