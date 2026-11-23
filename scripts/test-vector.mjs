// 语义检索冒烟测试：不碰数据库、不碰 Next，只验证"向量能不能找到对的内容"
// 用法：node scripts/test-vector.mjs "德国退货要付运费吗"

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { embedTexts, cosineSimilarity } = await import("../lib/knowledge/embed.ts");

const embeddingsPath = join(root, "data", "knowledge", "embeddings.json");
if (!existsSync(embeddingsPath)) {
  console.error("还没有 embeddings.json，先跑 node scripts/build-embeddings.mjs");
  process.exit(1);
}

const store = JSON.parse(readFileSync(embeddingsPath, "utf8"));
const queries = process.argv.slice(2);
if (queries.length === 0) {
  queries.push("德国退货要付运费吗", "退货要花钱吗", "狗窝能洗吗");
}

console.log(`索引：${store.count} 条 · 维度 ${store.dim} · 模型 ${store.model}\n`);

for (const query of queries) {
  const [queryVector] = await embedTexts([query]);

  const ranked = store.items
    .map((item) => ({ item, score: cosineSimilarity(queryVector, item.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  console.log(`问：${query}`);
  for (const { item, score } of ranked) {
    console.log(`   ${score.toFixed(4)}  [${item.id}] ${item.docTitle} · ${item.section}`);
  }
  console.log("");
}
