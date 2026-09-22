import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { getEnv } from "./env";

/**
 * 大模型客户端（服务端使用）
 * - 对话：DeepSeek（OpenAI 兼容协议）
 * - 嵌入：SiliconFlow BGE-M3（OpenAI 兼容协议）
 * 单例缓存，避免每次请求重复实例化。
 */

let chatModel: ChatOpenAI | null = null;

export function getChatModel(): ChatOpenAI {
  if (!chatModel) {
    chatModel = new ChatOpenAI({
      model: getEnv("CHAT_MODEL"),
      apiKey: getEnv("DEEPSEEK_API_KEY"),
      configuration: { baseURL: "https://api.deepseek.com" },
      temperature: 0.3,
    });
  }
  return chatModel;
}

let embeddings: OpenAIEmbeddings | null = null;

export function getEmbeddings(): OpenAIEmbeddings {
  if (!embeddings) {
    embeddings = new OpenAIEmbeddings({
      model: getEnv("EMBEDDING_MODEL"),
      apiKey: getEnv("SILICONFLOW_API_KEY"),
      configuration: { baseURL: "https://api.siliconflow.cn/v1" },
      batchSize: 32,
    });
  }
  return embeddings;
}
