import { deepSeek } from "@ai-sdk/deepseek";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

const SYSTEM_PROMPT =
  "你是一名专业、热情、有耐心的宠物跨境电商店铺金牌客服。你的任务是解答用户关于商品尺码、退换货政策、物流进度的疑问。如果用户问的问题你不知道（比如具体某个订单的物流号），请礼貌地引导用户提供订单号或转接人工客服。回答要简明扼要，多用礼貌用语。";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: deepSeek("deepseek-chat"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    providerOptions: {
      deepseek: {
        thinking: { type: "disabled" },
      },
    },
  });

  return result.toUIMessageStreamResponse();
}
