// 把知识库的 26 个 chunk 全部向量化，产出 data/knowledge/embeddings.json
// 用法：node scripts/build-embeddings.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// node 不会自动读 .env.local，这里手动解析（与 measure-latency.mjs 同一套做法）
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

const { embedTexts, embeddingConfig } = await import("../lib/knowledge/embed.ts");

const indexPath = join(root, "data", "knowledge", "index.json");
const outPath = join(root, "data", "knowledge", "embeddings.json");

const index = JSON.parse(readFileSync(indexPath, "utf8"));
const chunks = index.chunks;

if (!Array.isArray(chunks) || chunks.length === 0) {
  console.error("index.json 里没有 chunk，先跑 node scripts/build-knowledge.mjs");
  process.exit(1);
}

const { model } = embeddingConfig();
console.log(`向量化 ${chunks.length} 条 chunk · 模型 ${model}`);

const startedAt = Date.now();
const vectors = await embedTexts(chunks.map((chunk) => chunk.text));
const elapsed = Date.now() - startedAt;

const dim = vectors[0]?.length ?? 0;
if (dim === 0) {
  console.error("返回的向量是空的，检查接口响应");
  process.exit(1);
}

// 保留 6 位小数：够用且能把文件体积压到 1/3
const payload = {
  model,
  dim,
  builtAt: new Date().toISOString(),
  count: vectors.length,
  items: chunks.map((chunk, i) => ({
    id: chunk.id,
    docTitle: chunk.docTitle,
    section: chunk.section,
    text: chunk.text,
    vector: vectors[i].map((n) => Number(n.toFixed(6))),
  })),
};

writeFileSync(outPath, JSON.stringify(payload), "utf8");

const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024);
console.log(`\n完成：${vectors.length} 条向量 · 维度 ${dim} · 耗时 ${elapsed} ms`);
console.log(`已写入 ${relative(root, outPath)}（约 ${sizeKb} KB）`);
