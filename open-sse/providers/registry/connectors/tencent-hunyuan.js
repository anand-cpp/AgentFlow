export default {
  id: "tencent-hunyuan",
  priority: 91,
  alias: "tencent-hy",
  display: {
    name: "Tencent Hunyuan",
    icon: "smart_toy",
    color: "#0382F7",
    textIcon: "THP",
    website: "https://hunyuan.cloud.tencent.com/v1",
    notice: {
      apiKeyUrl: "https://hunyuan.cloud.tencent.com/v1/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  
  transport: {
    baseUrl: "https://hunyuan.cloud.tencent.com/v1",
    format: "openai",
    auth: {
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "tencent-hunyuan-model-1", name: "Tencent Hunyuan Model 1" },
    { id: "tencent-hunyuan-model-2", name: "Tencent Hunyuan Model 2" },
  ],
  serviceKinds: ["llm"],
};
