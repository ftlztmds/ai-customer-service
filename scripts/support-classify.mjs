// 越南语咨询意图分类评测（支持上下文）
// 用法：node scripts/support-classify.mjs
//
// 相比上一版的三处改动：
// 1. 支持 context 字段：把前 1-2 轮买家消息一起给模型判断（对应线上的多轮会话）
// 2. 支持 ambiguous 标记：上下文缺失、人工也无法判定的样本，单独统计、不计入准确率
// 3. 输出「分层准确率」：单句可判的 / 需要上下文的，分开看

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

const system = `你是越南语电商客服的意图分类器。把买家「最后一条消息」分到下面五类之一，只输出 JSON。

类别定义：
- engraving：定制刻字相关。要刻什么、怎么刻、刻完怎么下单、提供要刻的名字或电话。（关键词：khắc、tên、sđt、số điện thoại）
- delivery：物流异常。没收到货、送错地址、快递员送错、地址没错但没送到。（关键词：chưa nhận、lộn、giao nhầm、địa chỉ）
- stock：库存与现货。这个还有吗、有现货吗。（关键词：còn không、có sẵn）
- thanks：感谢与好评。cảm ơn、đẹp、感谢。
- other：其他。打招呼、找入口、问颜色、无明确诉求。

判断规则：
1. 如果提供了「上文」，必须结合上文判断——最后一句常省略主语和宾语（如 "có thấy đâu ạ" 要看上文问的是物流还是刻字入口）。
2. 越南语常省略主语和标点，拼写不规范（fai = phải、ròi = rồi、s = sao、sđth = số điện thoại），按语义判断。
3. 只有最后一条消息有歧义且上文也没帮助时，才归到 other。

只输出形如 {"intent":"engraving"} 的 JSON，不要解释。`;

async function classify(text, context = []) {
  const contextBlock = context.length > 0 ? `上文（买家之前说过）：\n${context.map((c) => `- ${c}`).join("\n")}\n\n` : "";

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      max_tokens: 40,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${contextBlock}最后一条消息：${text}` },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const json = await response.json();
  const raw = json.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw).intent ?? "other";
  } catch {
    return "other";
  }
}

const dataset = JSON.parse(readFileSync(join(root, "data", "support", "tickets.json"), "utf8"));
const items = dataset.items;

const scorable = items.filter((item) => !item.ambiguous);
const skipped = items.filter((item) => item.ambiguous);

console.log(`越南语意图分类评测：${items.length} 条（可评分 ${scorable.length}，歧义跳过 ${skipped.length}）\n`);

let correct = 0;
const errors = [];
const byIntent = {};

for (const item of scorable) {
  const predicted = await classify(item.text, item.context ?? []);
  const ok = predicted === item.intent;
  if (ok) correct++;
  else errors.push({ ...item, predicted });

  byIntent[item.intent] ??= { total: 0, hit: 0 };
  byIntent[item.intent].total++;
  if (ok) byIntent[item.intent].hit++;

  const ctx = item.context?.length ? `「上文 ${item.context.length} 条」` : "";
  console.log(`${ok ? "✅" : "❌"} ${item.id}  [${item.intent}${ok ? "" : ` → ${predicted}`}] ${ctx} ${item.text}`);
  await new Promise((resolve) => setTimeout(resolve, 120));
}

console.log(`\n总体准确率 ${((correct / scorable.length) * 100).toFixed(1)}%  (${correct}/${scorable.length})`);

console.log("\n分类别：");
for (const [intent, stat] of Object.entries(byIntent)) {
  console.log(`  ${intent.padEnd(10)} ${stat.hit}/${stat.total}`);
}

if (errors.length > 0) {
  console.log("\n错例：");
  for (const err of errors) {
    console.log(`  ${err.id} 标注=${err.intent} 预测=${err.predicted}  「${err.text}」`);
  }
}

if (skipped.length > 0) {
  console.log(`\n跳过 ${skipped.length} 条歧义样本（上下文缺失，人工也无法判定）：`);
  for (const item of skipped) console.log(`  ${item.id}  「${item.text}」`);
}
