// 刻字咨询：子意图识别 + 槽位抽取 + 越南语回复生成
// 用法：node scripts/support-extract.mjs
//
// v2 相比 v1 的改动：一次调用同时输出「子意图 + 槽位」
//   sub_intent: provide  → 买家在提供/要提供信息 → 追问缺的字段
//               how_to   → 买家问「怎么刻 / 刻完怎么下单」 → 给操作步骤
//               find_entry → 买家找不到备注入口 → 指路
//               confirm  → 买家在确认（"刻在绳子上对吧"） → 确认 + 补问
//
// 为什么要分子意图：v1 把所有刻字咨询都当成「要提供信息」，
// 导致 27% 的回复答非所问（问流程的人被要求填信息）。

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) throw new Error("缺少 .env.local");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.*)$/);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(".env.local 里没有 DEEPSEEK_API_KEY");
}

const API_KEY = loadKey();
const templates = JSON.parse(readFileSync(join(root, "data", "support", "engraving-templates.json"), "utf8")).templates;

const system = `你是越南语定制刻字订单的意图与槽位抽取器，只输出 JSON。

先判断子意图 sub_intent：
- provide：买家在提供信息，或表达「想刻」并会提供信息。例：「Khắc tên Nâu」「muốn khắc tên sđt」
- how_to：买家在问操作流程。例：「khắc tên như nào」「khắc xong rồi đặt thì làm sao」「không biết khắc tên sao」
- find_entry：买家找不到下单备注入口。例：「có thấy đâu ạ」「ở đâu ạ」（通常在客服说明「要备注」之后出现）
- confirm：买家在确认某种做法是否正确。例：「khắc trên dây rồi phải không ạ」「fai ko ạ」

再抽取槽位：
- wants_name：要刻名字（提到 tên / khắc tên）
- wants_phone：要刻电话（提到 sđt / số điện thoại）
- name_value：要刻的名字原文（Nâu / BIN / meo / sữa / Mi），没有则 null，不要翻译、不要臆造
- phone_value：要刻的电话号码，没有则 null
- color：颜色（đen / bạc / vàng），没有则 null

判断要点：
1. 有「怎么/如 nào/làm sao/sao hết」等疑问词，且问的是操作方法 → how_to
2. 有「đâu（哪里）」「thấy（看到）」且客服上文提到备注 → find_entry
3. 有「phải không / fai ko / đúng không」→ confirm
4. 句子只有信息没有疑问 → provide

只输出形如：
{"sub_intent":"provide","wants_name":true,"wants_phone":false,"name_value":"Nâu","phone_value":null,"color":null}`;

async function analyze(text, context = []) {
  const contextBlock = context.length ? `客服上文：\n${context.map((c) => `- ${c}`).join("\n")}\n\n` : "";

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      max_tokens: 160,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${contextBlock}买家消息：${text}` },
      ],
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = await response.json();
  try {
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
    return { sub_intent: parsed.sub_intent ?? "provide", ...parsed };
  } catch {
    return { sub_intent: "provide" };
  }
}

/** 纯规则：按子意图选模板，再按缺失字段补问（这层不交给模型） */
function buildReply(slots) {
  const name = slots.name_value?.trim() || null;
  const phone = slots.phone_value?.trim() || null;

  switch (slots.sub_intent) {
    case "how_to":
      return templates.how_to;
    case "find_entry":
      return templates.find_entry;
    case "confirm":
      return name ? templates.confirm_with_name.replace("{name}", name) : templates.confirm;
    default:
      // provide：只问缺的
      if (slots.wants_name && name && slots.wants_phone && phone) {
        return templates.confirm_with_name.replace("{name}", name) + " " + templates.ask_phone;
      }
      if (name && !phone) return templates.ask_phone;
      if (!name && slots.wants_phone) return templates.ask_name_phone;
      if (slots.wants_name && !name) return templates.ask_name;
      return templates.ask_name_phone;
  }
}

const dataset = JSON.parse(readFileSync(join(root, "data", "support", "tickets.json"), "utf8"));
const items = dataset.items.filter((item) => item.intent === "engraving" && !item.ambiguous);

console.log(`刻字类咨询 ${items.length} 条：子意图 + 槽位 + 回复\n`);

const tally = { provide: 0, how_to: 0, find_entry: 0, confirm: 0 };

for (const item of items) {
  const result = await analyze(item.text, item.context ?? []);
  tally[result.sub_intent] = (tally[result.sub_intent] ?? 0) + 1;

  const filled = [
    result.name_value ? `name=${result.name_value}` : null,
    result.phone_value ? `phone=${result.phone_value}` : null,
    result.color ? `color=${result.color}` : null,
  ].filter(Boolean).join(" ");

  console.log(`▸ ${item.id}「${item.text}」`);
  console.log(`  子意图：${result.sub_intent}　槽位：${filled || "（空）"}`);
  console.log(`  回复：${buildReply(result)}\n`);

  await new Promise((resolve) => setTimeout(resolve, 120));
}

console.log("子意图分布：", tally);
