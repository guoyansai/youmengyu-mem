/**
 * AI 服务预设源（移植自 asaiwriter plugins-work/ai/presets.ts）。
 * 只有地址和默认模型名，不内置任何密钥：免费模型是公开接口和免费额度，在线模型需自带密钥，
 * 离线模型是本机推理服务。文本预设按 lane 落在对应通路。
 */
export type ConnLane = 'offline' | 'online' | 'free';

export type Preset = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  protocol?: ProviderProtocol;
  apiVersion?: string;
  /** 免密钥（公共免费接口，有限流） */
  keyless?: boolean;
  /** 文本预设落在哪条连接 */
  lane: ConnLane;
};

export type ProviderProtocol = 'openai' | 'azure' | 'anthropic' | 'gemini' | 'ollama' | 'text-get';

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = [
  'openai',
  'azure',
  'anthropic',
  'gemini',
  'ollama',
  'text-get',
];

export const PRESETS: Preset[] = [
  // 免费通路：免密钥公共接口
  { id: 'free-pollinations', name: 'Pollinations（免密钥）', baseUrl: 'https://text.pollinations.ai', model: 'openai-fast', needsKey: false, protocol: 'text-get', keyless: true, lane: 'free' },
  { id: 'free-llm7', name: 'LLM7（免密钥）', baseUrl: 'https://api.llm7.io/v1', model: 'default', needsKey: false, keyless: true, lane: 'free' },
  { id: 'free-llm7-fast', name: 'LLM7 快速（免密钥）', baseUrl: 'https://api.llm7.io/v1', model: 'fast', needsKey: false, keyless: true, lane: 'free' },
  // 免费通路：免费额度（需注册密钥）
  { id: 'preset-groq', name: 'Groq（免费额度）', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', needsKey: true, lane: 'free' },
  { id: 'preset-gemini', name: 'Gemini OpenAI 兼容（免费额度）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', needsKey: true, lane: 'free' },
  { id: 'preset-gemini-native', name: 'Gemini 原生（免费额度）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', needsKey: true, protocol: 'gemini', lane: 'free' },
  { id: 'preset-siliconflow', name: '硅基流动（免费额度）', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', needsKey: true, lane: 'free' },
  { id: 'preset-openrouter', name: 'OpenRouter（:free 模型）', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', needsKey: true, lane: 'free' },
  { id: 'preset-cerebras', name: 'Cerebras（免费额度）', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama3.1-8b', needsKey: true, lane: 'free' },
  { id: 'preset-mistral', name: 'Mistral（免费额度）', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', needsKey: true, lane: 'free' },
  { id: 'preset-zhipu-flash', name: '智谱 GLM-4-Flash（免费）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', needsKey: true, lane: 'free' },
  { id: 'preset-qwen-free', name: '通义千问（免费额度）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo', needsKey: true, lane: 'free' },
  { id: 'preset-ernie-speed', name: '文心 Speed（免费额度）', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'ernie-speed-128k', needsKey: true, lane: 'free' },
  { id: 'preset-hunyuan-lite', name: '混元 Lite（免费额度）', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-lite', needsKey: true, lane: 'free' },
  { id: 'preset-spark-lite', name: '讯飞星火 Lite（免费额度）', baseUrl: 'https://spark-api-open.xf-yun.com/v1', model: 'lite', needsKey: true, lane: 'free' },
  { id: 'preset-modelscope', name: '魔搭 ModelScope（免费额度）', baseUrl: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', needsKey: true, lane: 'free' },
  { id: 'preset-gitee', name: 'Gitee AI（免费额度）', baseUrl: 'https://ai.gitee.com/v1', model: 'Qwen2.5-7B-Instruct', needsKey: true, lane: 'free' },
  { id: 'preset-huggingface', name: 'Hugging Face（免费额度）', baseUrl: 'https://router.huggingface.co/v1', model: 'meta-llama/Llama-3.1-8B-Instruct', needsKey: true, lane: 'free' },
  { id: 'preset-github', name: 'GitHub Models（免费额度）', baseUrl: 'https://models.github.ai/inference', model: 'openai/gpt-4o-mini', needsKey: true, lane: 'free' },
  // 在线通路：自带密钥的付费服务
  { id: 'preset-deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', needsKey: true, lane: 'online' },
  { id: 'preset-qwen', name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true, lane: 'online' },
  { id: 'preset-doubao', name: '豆包 Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115', needsKey: true, lane: 'online' },
  { id: 'preset-zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', needsKey: true, lane: 'online' },
  { id: 'preset-kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', needsKey: true, lane: 'online' },
  { id: 'preset-ernie', name: '文心 ERNIE', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.0-turbo-8k', needsKey: true, lane: 'online' },
  { id: 'preset-minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-Text-01', needsKey: true, lane: 'online' },
  { id: 'preset-openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true, lane: 'online' },
  { id: 'preset-azure', name: 'Azure OpenAI', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT', model: '', needsKey: true, protocol: 'azure', apiVersion: '2024-10-21', lane: 'online' },
  { id: 'preset-anthropic', name: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest', needsKey: true, protocol: 'anthropic', lane: 'online' },
  { id: 'preset-gemini-pro', name: 'Gemini Pro', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro', needsKey: true, protocol: 'gemini', lane: 'online' },
  { id: 'preset-xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-3-mini', needsKey: true, lane: 'online' },
  // 离线通路：本机推理服务
  { id: 'preset-ollama', name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:0.5b', needsKey: false, protocol: 'ollama', lane: 'offline' },
  { id: 'preset-lmstudio', name: 'LM Studio（本机）', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', needsKey: false, lane: 'offline' },
  { id: 'custom', name: '自定义 / Custom', baseUrl: '', model: '', needsKey: true, lane: 'online' },
];
