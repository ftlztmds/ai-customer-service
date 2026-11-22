import type { UIMessage } from "ai";

/** 一条命中的知识库片段，随助手消息一起回传，用于前端展示「依据」 */
export type KnowledgeSource = {
  id: string;
  docTitle: string;
  section: string;
  score: number;
};

/** 挂在 assistant 消息上的元数据 */
export type MessageMetadata = {
  /** 是否检索到足够可靠的资料（false 表示已转人工） */
  grounded: boolean;
  sources: KnowledgeSource[];
};

export type ChatUIMessage = UIMessage<MessageMetadata>;
