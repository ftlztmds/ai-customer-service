import { deepSeek } from "@ai-sdk/deepseek";
import { convertToModelMessages, createUIMessageStreamResponse, streamText } from "ai";
import { searchKnowledge } from "@/lib/knowledge/retrieve";
import { buildMetadata, buildSystemPrompt } from "@/lib/chat/prompt";
import type { ChatUIMessage } from "@/lib/chat/types";

function lastUserText(messages: ChatUIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (!last) return "";
  return last.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join(" ")
    .trim();
}

export async function POST(req: Request) {
  const { messages }: { messages: ChatUIMessage[] } = await req.json();

  const query = lastUserText(messages);

  // 先检索：命中则基于资料作答，未命中则强制转人工（闸门在 retrieve 内）
  const retrieval = searchKnowledge(query);

  console.log(
    retrieval.grounded
      ? `[knowledge] 命中 ${retrieval.hits.length} 条 | query="${query}" | ` +
          retrieval.hits.map((hit) => `${hit.chunk.id}=${hit.score.toFixed(1)}`).join(" ")
      : `[knowledge] 未命中，转人工 | query="${query}" | top=${retrieval.topScore.toFixed(2)}`,
  );

  const result = streamText({
    model: deepSeek("deepseek-chat"),
    system: buildSystemPrompt(query, retrieval),
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
