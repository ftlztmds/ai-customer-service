// 构建知识库索引：把 data/knowledge/*.md 切分为 chunk 并写出 JSON 索引
// 用法：node scripts/build-knowledge.mjs

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkMarkdown } from "../lib/knowledge/chunk.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "data", "knowledge");
const outFile = join(sourceDir, "index.json");

const files = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

if (files.length === 0) {
  console.error(`没有找到任何 .md 文档：${sourceDir}`);
  process.exit(1);
}

const chunks = [];
for (const file of files) {
  const raw = readFileSync(join(sourceDir, file), "utf8");
  const docId = file.replace(/\.md$/, "");
  const docChunks = chunkMarkdown(docId, raw);
  chunks.push(...docChunks);
  console.log(`${file}  →  ${docChunks.length} chunk`);
}

const index = {
  builtAt: new Date().toISOString(),
  chunkCount: chunks.length,
  chunks,
};

mkdirSync(sourceDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(index, null, 2), "utf8");

const avgLen = Math.round(chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length);
console.log(`\n共 ${chunks.length} 个 chunk，平均 ${avgLen} 字`);
console.log(`索引已写入 ${relative(root, outFile)}`);
