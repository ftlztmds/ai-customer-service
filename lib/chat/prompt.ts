/**
 * 客服提示词装配（纯函数，不依赖 I/O 与框架）
 *
 * 抽出来的目的：线上 route.ts 与离线评测脚本 scripts/eval.mjs 必须共用同一套 prompt，
 * 否则"评测通过"与"线上表现"会脱钩，评测就失去意义。
 */

import type { Retrieval } from "@/lib/knowledge/retrieve";
import type { MessageMetadata } from "./types";

export const PERSONA = `你是一名专业、热情、有耐心的宠物跨境电商店铺「天乐时代旗舰店」金牌客服。
你的任务是解答用户关于商品尺码、退换货政策、物流进度的疑问。
回答要简明扼要，多用礼貌用语。回答一律使用纯文本，不要输出 Markdown 标记（如 **加粗**、# 标题、- 列表）；需要分点时直接写「1. 2. 3.」，每条之间换行。`;

/** 检索未命中时的约束：不知道就说不知道，不许编 */
export const REQUIRED_HANDOFF = "礼貌地请用户提供订单号，或说明将为用户转接人工客服";

export function buildSystemPrompt(query: string, retrieval: Retrieval): string {
  if (!retrieval.grounded) {
    return `${PERSONA}

【本轮约束】本轮没有检索到可依据的资料。不要编造任何政策、价格、时效或库存信息；直接${REQUIRED_HANDOFF}。`;
  }

  const context = retrieval.hits
    .map((hit, i) => `[${i + 1}] ${hit.chunk.docTitle} · ${hit.chunk.section}\n${hit.chunk.text}`)
    .join("\n\n");

  return `${PERSONA}

【参考资料】
${context}

【回答约束】
1. 只能依据上述参考资料作答，不得编造价格、时效、政策、库存。
2. 参考资料未覆盖的信息，不要猜测，改为${REQUIRED_HANDOFF}。
3. 不要提及「参考资料」「文档」「资料」等字眼，直接以客服口吻回答。
4. 涉及具体型号时，型号字母与尺码必须与资料完全一致，不得改写。
5. 只回答用户本次问到的部分，不要把资料里其他条款一并罗列；回答控制在 5 句话以内。
6. 涉及国家或地区时，必须先确认资料里明确列出了该市场。资料没有列出的市场，说明目前支持的市场范围，不要推断"可以发货"或给出该市场的运费、时效。`;
}

/** 供前端展示「依据」的元数据 */
export function buildMetadata(retrieval: Retrieval): MessageMetadata {
  if (!retrieval.grounded) return { grounded: false, sources: [] };

  return {
    grounded: true,
    sources: retrieval.hits.map((hit) => ({
      id: hit.chunk.id,
      docTitle: hit.chunk.docTitle,
      section: hit.chunk.section,
      score: Math.round(hit.score * 10) / 10,
    })),
  };
}
