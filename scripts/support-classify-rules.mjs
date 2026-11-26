// 规则版意图分类器（对照组）
// 用法：node scripts/support-classify-rules.mjs
//
// 目的：用同一批 30 条真实咨询，对比「纯关键词规则」和「大模型」的准确率。
// 这不是为了证明规则没用，而是为了说清一件事：
//   哪些判断规则能覆盖，哪些必须靠语义理解。
//
// 规则的设计刻意写得「合理」——不是故意写烂：
//   1. 按优先级匹配（thanks > delivery > stock > engraving），避免多类关键词冲突
//   2. 覆盖了越南语常见缩写（cam on / sdt / sđth / sp）
//   3. 但这套规则看不了上下文 —— 这正是它和 LLM 的本质差距

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 按优先级排列：先匹配到的优先
const RULES = [
  {
    intent: "thanks",
    keywords: ["cảm ơn", "cảm on", "cam on", "thanks", "đẹp", "tuyệt"],
  },
  {
    intent: "delivery",
    keywords: ["chưa nhận", "chua nhan", "lộn", "lon nha", "nhầm", "nham", "giao", "ship", "địa chỉ", "dia chi", "đơn hàng", "don hang"],
  },
  {
    intent: "stock",
    keywords: ["còn không", "con khong", "còn k", "có sẵn", "co san", "hết hàng", "het hang"],
  },
  {
    intent: "engraving",
    keywords: ["khắc", "khac", "tên", "ten", "sđt", "sdt", "số điện thoại", "so dien thoai", "chữ", "chu"],
  },
];

function classify(text) {
  const lower = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => lower.includes(keyword))) return rule.intent;
  }
  return "other";
}

const dataset = JSON.parse(readFileSync(join(root, "data", "support", "tickets.json"), "utf8"));
const scorable = dataset.items.filter((item) => !item.ambiguous);

console.log(`规则版分类器：${scorable.length} 条可评分样本\n`);

let correct = 0;
const errors = [];

for (const item of scorable) {
  const predicted = classify(item.text);
  const ok = predicted === item.intent;
  if (ok) correct++;
  else errors.push({ ...item, predicted });

  console.log(`${ok ? "✅" : "❌"} ${item.id}  [${item.intent}${ok ? "" : ` → ${predicted}`}]  ${item.text}`);
}

const accuracy = (correct / scorable.length) * 100;
console.log(`\n规则版准确率 ${accuracy.toFixed(1)}%  (${correct}/${scorable.length})`);

if (errors.length > 0) {
  console.log(`\n规则版错例 ${errors.length} 条（这些就是规则覆盖不到的语义判断）：`);
  for (const err of errors) {
    console.log(`  ${err.id} 标注=${err.intent} 预测=${err.predicted}  「${err.text}」`);
  }
}

console.log("\n对照结论：");
console.log("1. 规则版靠关键词，遇到「没有关键词但要靠上下文」的句子必然出错");
console.log("2. 大模型版（support-classify.mjs）在这些句子上能靠语义和上下文判断");
console.log("3. 但规则版几乎零成本、零延迟 —— 所以真实系统里应该是「规则优先 + 模型兜底」");
