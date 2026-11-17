export default {
  id: "amazon-bedrock",
  priority: 61,
  alias: "bedrock",
  display: {
    name: "Amazon Bedrock",
    icon: "smart_toy",
    color: "#FF9900",
    textIcon: "AB",
    website: "https://bedrock-runtime.us-east-1.amazonaws.com",
    notice: {
      apiKeyUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    format: "bedrock",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "amazon-bedrock-model-1", name: "Amazon Bedrock Model 1" },
    { id: "amazon-bedrock-model-2", name: "Amazon Bedrock Model 2" },
  ],
  serviceKinds: ["llm"],
};
