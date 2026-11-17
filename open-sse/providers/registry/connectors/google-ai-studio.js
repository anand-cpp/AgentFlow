export default {
  id: "google-ai-studio",
  priority: 64,
  alias: "google-studio",
  display: {
    name: "Google AI Studio",
    icon: "smart_toy",
    color: "#4285F4",
    textIcon: "GAS",
    website: "https://generativelanguage.googleapis.com/v1",
    notice: {
      apiKeyUrl: "https://generativelanguage.googleapis.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://generativelanguage.googleapis.com/v1",
    format: "gemini",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "google-ai-studio-model-1", name: "Google AI Studio Model 1" },
    { id: "google-ai-studio-model-2", name: "Google AI Studio Model 2" },
  ],
  serviceKinds: ["llm"],
};
