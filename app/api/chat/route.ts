import { deepSeek } from "@ai-sdk/deepseek";
import { convertToModelMessages, createUIMessageStreamResponse, streamText } from "ai";
import { searchKnowledge } from "@/lib/knowledge/retrieve";
import type { ChatUIMessage, MessageMetadata } from "@/lib/chat/types";

const PERSONA = `你是一名专业、热情、有耐心的宠物跨境电商店铺「天乐时代旗舰店」金牌客服。
你的任务是解答用户关于商品尺码、退换货政策、物流进度的疑问。
回答要简明扼要，多用礼貌用语。回答一律使用纯文本，不要输出 Markdown 标记（如 **加粗**、# 标题、- 列表）；需要分点时直接写「1. 2. 3.」，每条之间换行。`;

/** 检索未命中时的约束：不知道就说不知道，不许编 */
const REQUIRED_HANDOFF = "礼貌地请用户提供订单号，或说明将为用户转接人工客服";

function lastUserText(messages: ChatUIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (!last) return "";
  return last.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join(" ")
    .trim();
}

/**
 * 先检索，再决定提示词：
 * - 命中  → 注入【参考资料】+ 强约束，只许照着答
 * - 未命中 → 切换为转人工约束，不允许生成任何事实
 * 同时产出 metadata，供前端展示「依据」，便于定位是检索错还是生成错。
 */
function buildPrompt(query: string): { system: string; metadata: MessageMetadata } {
  const retrieval = searchKnowledge(query, 4);

  if (!retrieval.grounded) {
    console.log(`[knowledge] 未命中，转人工 | query="${query}" | top=${retrieval.topScore.toFixed(2)}`);
    return {
      system: `${PERSONA}

【本轮约束】本轮没有检索到可依据的资料。不要编造任何政策、价格、时效或库存信息；直接${REQUIRED_HANDOFF}。`,
      metadata: { grounded: false, sources: [] },
    };
  }

  console.log(
    `[knowledge] 命中 ${retrieval.hits.length} 条 | query="${query}" | ` +
      retrieval.hits.map((hit) => `${hit.chunk.id}=${hit.score.toFixed(1)}`).join(" "),
  );

  const context = retrieval.hits
    .map((hit, i) => `[${i + 1}] ${hit.chunk.docTitle} · ${hit.chunk.section}\n${hit.chunk.text}`)
    .join("\n\n");

  return {
    system: `${PERSONA}

【参考资料】
${context}

【回答约束】
1. 只能依据上述参考资料作答，不得编造价格、时效、政策、库存。
2. 参考资料未覆盖的信息，不要猜测，改为${REQUIRED_HANDOFF}。
3. 不要提及「参考资料」「文档」「资料」等字眼，直接以客服口吻回答。
4. 涉及具体型号时，型号字母与尺码必须与资料完全一致，不得改写。`,
    metadata: {
      grounded: true,
      sources: retrieval.hits.map((hit) => ({
        id: hit.chunk.id,
        docTitle: hit.chunk.docTitle,
        section: hit.chunk.section,
        score: Math.round(hit.score * 10) / 10,
      })),
    },
  };
}

export async function POST(req: Request) {
  const { messages }: { messages: ChatUIMessage[] } = await req.json();

  const { system, metadata } = buildPrompt(lastUserText(messages));

  const result = streamText({
    model: deepSeek("deepseek-chat"),
    system,
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
      // metadata 会写进 assistant 消息的 metadata 字段，前端据此渲染「依据」
      messageMetadata: () => metadata,
    }),
  });
}
