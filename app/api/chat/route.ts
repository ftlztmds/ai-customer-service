import { deepSeek } from "@ai-sdk/deepseek";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  streamText,
} from "ai";
import { searchKnowledge, type Retrieval } from "@/lib/knowledge/retrieve";
import { buildMetadata, buildSystemPrompt } from "@/lib/chat/prompt";
import type { ChatUIMessage } from "@/lib/chat/types";

function messageText(message: ChatUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join(" ")
    .trim();
}

function lastUserText(messages: ChatUIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  return last ? messageText(last) : "";
}

/** 改写时可参考的历史用户消息（不含最后一条） */
function historyUserTexts(messages: ChatUIMessage[], limit = 2): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter(Boolean)
    .slice(-(limit + 1), -1);
}

const REWRITE_SYSTEM = `你是查询改写器。把用户最后一句问话改写成一个不依赖上下文、语义完整的独立问句。
规则：
1. 把代词（这个、那个、它、那）替换成上文提到的具体对象（如国家、商品、尺码）。
2. 保留原问题的意图，不要回答问题。
3. 只输出改写后的问句，不要解释、不要引号、不要前缀。`;

/**
 * 指代消解：把「那这个呢」改写成「日本退货要付运费吗」。
 * 失败时返回 null，调用方退回归档逻辑，不影响主链路。
 */
async function rewriteQuery(
  history: string[],
  lastQuestion: string,
): Promise<string | null> {
  if (history.length === 0) return null;

  try {
    const { text } = await generateText({
      model: deepSeek("deepseek-chat"),
      temperature: 0,
      maxOutputTokens: 60,
      system: REWRITE_SYSTEM,
      prompt: `上文用户问过：${history.join("；")}\n最后一句：${lastQuestion}`,
    });

    const rewritten = text.trim().replace(/^["'「『]|["'」』]$/g, "").trim();
    // 改写结果为空、过长、或没变化，都视为失败
    if (!rewritten || rewritten.length > 100 || rewritten === lastQuestion) return null;
    return rewritten;
  } catch (error) {
    console.error("[rewrite] 改写失败，退回原句", (error as Error).message);
    return null;
  }
}

/**
 * 检索主流程：
 *   1. 直接用原句检索（绝大多数问题自包含，零额外延迟）
 *   2. 未命中且有历史时，才花一次 LLM 调用做改写并重试
 * 这样把成本放在失败路径上，不为常见路径付延迟。
 */
async function retrieveWithRewrite(
  messages: ChatUIMessage[],
  query: string,
): Promise<{ retrieval: Retrieval; rewritten: string | null }> {
  const first = searchKnowledge(query);
  if (first.grounded) return { retrieval: first, rewritten: null };

  const rewritten = await rewriteQuery(historyUserTexts(messages), query);
  if (!rewritten) return { retrieval: first, rewritten: null };

  const retry = searchKnowledge(rewritten);
  if (!retry.grounded) return { retrieval: first, rewritten };

  return { retrieval: retry, rewritten };
}

export async function POST(req: Request) {
  const { messages }: { messages: ChatUIMessage[] } = await req.json();

  const query = lastUserText(messages);
  const { retrieval, rewritten } = await retrieveWithRewrite(messages, query);

  console.log(
    retrieval.grounded
      ? `[knowledge] 命中 ${retrieval.hits.length} 条 | query="${retrieval.query}"` +
          (rewritten ? ` | 由「${query}」改写而来` : "") +
          " | " +
          retrieval.hits.map((hit) => `${hit.chunk.id}=${hit.score.toFixed(1)}`).join(" ")
      : `[knowledge] 未命中，转人工 | query="${query}" | top=${retrieval.topScore.toFixed(2)}` +
          (rewritten ? ` | 改写后仍无资料："${rewritten}"` : ""),
  );

  const result = streamText({
    model: deepSeek("deepseek-chat"),
    system: buildSystemPrompt(retrieval),
    messages: await convertToModelMessages(messages),
    providerOptions: {
      deepseek: {
        thinking: { type: "disabled" },
      },
    },
  });

  return createUIMessageStreamResponse({
    stream: result.toUIMessageStream({
      originalMessages: messages,
      // metadata 写进 assistant 消息，前端据此渲染「依据」
      messageMetadata: () => buildMetadata(retrieval),
    }),
  });
}
