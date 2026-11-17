export default {
  id: "google-vertex",
  priority: 62,
  alias: "vertex-ai",
  display: {
    name: "Google Vertex AI",
    icon: "smart_toy",
    color: "#4285F4",
    textIcon: "GV",
    website: "https://us-central1-aiplatform.googleapis.com",
    notice: {
      apiKeyUrl: "https://us-central1-aiplatform.googleapis.com/keys",
    },
  },
  category: "oauth",
  authType: "oauth",
  authModes: ["oauth"],
  
  transport: {
    baseUrl: "https://us-central1-aiplatform.googleapis.com",
    format: "vertex",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "google-vertex-model-1", name: "Google Vertex AI Model 1" },
    { id: "google-vertex-model-2", name: "Google Vertex AI Model 2" },
  ],
  serviceKinds: ["llm"],
};
