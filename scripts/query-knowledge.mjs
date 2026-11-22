// 检索调试工具：看某个问题会命中哪些 chunk、分数与覆盖率、是否触发转人工
// 用法：node scripts/query-knowledge.mjs "德国退货要付运费吗"

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { createSearcher, filterHits, MIN_SCORE, MIN_COVERAGE } = await import("../lib/knowledge/scorer.ts");

const index = JSON.parse(readFileSync(join(root, "data", "knowledge", "index.json"), "utf8"));
const search = createSearcher(index.chunks);

// 与线上 retrieve.ts 同一条路径：打分后过滤掉实词覆盖为 0 的噪声片段
const retrieve = (query) => filterHits(search(query, 4));

const queries = process.argv.slice(2);
if (queries.length === 0) {
  queries.push("怎么退换货？", "德国退货要付运费吗", "TL-DW-M 多少钱", "你们老板是谁");
}

console.log(
  `索引 ${index.chunkCount} chunk · 构建于 ${index.builtAt}\n闸门 score >= ${MIN_SCORE} 且 coverage >= ${MIN_COVERAGE}\n`,
);

for (const query of queries) {
  const hits = retrieve(query);
  const top = hits[0];
  const grounded = !!top && top.score >= MIN_SCORE && top.coverage >= MIN_COVERAGE;
  console.log(`问：${query}`);
  console.log(
    `  → ${grounded ? "命中资料" : "未命中，转人工"}` +
      (top ? `（top ${top.score.toFixed(2)} / 覆盖率 ${(top.coverage * 100).toFixed(0)}%）` : ""),
  );
  for (const hit of hits) {
    console.log(
      `    ${hit.score.toFixed(2).padStart(6)}  覆盖 ${(hit.coverage * 100).toFixed(0).padStart(3)}%  [${hit.chunk.id}] ${hit.chunk.docTitle} · ${hit.chunk.section}`,
    );
  }
  console.log("");
}
