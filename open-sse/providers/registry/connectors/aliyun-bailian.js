export default {
  id: "aliyun-bailian",
  priority: 90,
  alias: "aliyun-bailian",
  display: {
    name: "Aliyun Bailian",
    icon: "smart_toy",
    color: "#FF6A00",
    textIcon: "ABL",
    website: "https://dashscope.aliyuncs.com/api/v1",
    notice: {
      apiKeyUrl: "https://dashscope.aliyuncs.com/api/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "aliyun-bailian-model-1", name: "Aliyun Bailian Model 1" },
    { id: "aliyun-bailian-model-2", name: "Aliyun Bailian Model 2" },
  ],
  serviceKinds: ["llm"],
};
