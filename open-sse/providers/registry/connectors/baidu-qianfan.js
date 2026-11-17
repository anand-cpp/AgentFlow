export default {
  id: "baidu-qianfan",
  priority: 92,
  alias: "baidu-qf",
  display: {
    name: "Baidu Qianfan",
    icon: "smart_toy",
    color: "#2932E6",
    textIcon: "BQP",
    website: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1",
    notice: {
      apiKeyUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "baidu-qianfan-model-1", name: "Baidu Qianfan Model 1" },
    { id: "baidu-qianfan-model-2", name: "Baidu Qianfan Model 2" },
  ],
  serviceKinds: ["llm"],
};
