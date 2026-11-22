// 知识库评测：检索层（离线，秒级）+ 回答层（--live，需 DEEPSEEK_API_KEY）
//
//   node scripts/eval.mjs          只跑检索层
//   node scripts/eval.mjs --live   追加回答层，约 40 次 API 请求
//
// 输出结论写入 data/eval/latest-report.json，便于对比多次改动的效果。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");

const { createSearcher, filterHits, MIN_SCORE, MIN_COVERAGE } = await import("../lib/knowledge/scorer.ts");
const { buildSystemPrompt } = await import("../lib/chat/prompt.ts");

const index = JSON.parse(readFileSync(join(root, "data/knowledge/index.json"), "utf8"));
const set = JSON.parse(readFileSync(join(root, "data/eval/questions.json"), "utf8"));
const search = createSearcher(index.chunks);

const TOP_K = 3;
const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

function retrieve(query) {
  // 与线上 retrieve.ts 保持同一条路径：先打分，再过滤噪声片段
  const hits = filterHits(search(query, TOP_K));
  const top = hits[0];
  const topScore = top?.score ?? 0;
  const topCoverage = top?.coverage ?? 0;
  return {
    query,
    hits,
    topScore,
    topCoverage,
    grounded: topScore >= MIN_SCORE && topCoverage >= MIN_COVERAGE,
  };
}

// ---------- 检索层 ----------
const rows = set.items.map((item) => {
  const r = retrieve(item.question);
  const topDoc = r.hits[0]?.chunk.docId ?? null;
  const isOutOfScope = item.doc === null;
  return {
    id: item.id,
    question: item.question,
    expectedDoc: item.doc,
    expectedHandoff: isOutOfScope,
    ...r,
    topDoc,
    // 判定正确：该答的判为可答，该拒的判为拒答
    verdictOk: isOutOfScope ? !r.grounded : r.grounded,
    // 定位正确：Top-1 落在期望文档（仅对有答案的题目有意义）
    top1Ok: isOutOfScope ? null : topDoc === item.doc,
    hit3: isOutOfScope ? null : r.hits.some((hit) => hit.chunk.docId === item.doc),
  };
});

const inScope = rows.filter((row) => !row.expectedHandoff);
const outScope = rows.filter((row) => row.expectedHandoff);

const retrievalMetrics = {
  total: rows.length,
  inScope: inScope.length,
  outScope: outScope.length,
  verdictAccuracy: rows.filter((r) => r.verdictOk).length / rows.length,
  top1Accuracy: inScope.filter((r) => r.top1Ok).length / inScope.length,
  hit3Recall: inScope.filter((r) => r.hit3).length / inScope.length,
  rejectAccuracy: outScope.filter((r) => !r.grounded).length / outScope.length,
};

console.log(`\n=== 检索层评测（离线）===`);
console.log(`样本 ${rows.length} 条：${inScope.length} 条有答案 · ${outScope.length} 条应转人工`);
console.log(`阈值：score >= ${MIN_SCORE} 且 coverage >= ${MIN_COVERAGE} · Top-K = ${TOP_K}\n`);
console.log(`判定准确率   ${pct(retrievalMetrics.verdictAccuracy * rows.length, rows.length)}  (${rows.filter((r) => r.verdictOk).length}/${rows.length})`);
console.log(`Top-1 定位   ${pct(retrievalMetrics.top1Accuracy * inScope.length, inScope.length)}  (${inScope.filter((r) => r.top1Ok).length}/${inScope.length})`);
console.log(`Hit@${TOP_K} 召回   ${pct(retrievalMetrics.hit3Recall * inScope.length, inScope.length)}  (${inScope.filter((r) => r.hit3).length}/${inScope.length})`);
console.log(`拒答准确率   ${pct(retrievalMetrics.rejectAccuracy * outScope.length, outScope.length)}  (${outScope.filter((r) => !r.grounded).length}/${outScope.length})`);

const failures = rows.filter((r) => !r.verdictOk || r.top1Ok === false);
if (failures.length > 0) {
  console.log(`\n失败样本 ${failures.length} 条：`);
  for (const f of failures) {
    const got = f.grounded ? `命中 ${f.topDoc}` : "转人工";
    const want = f.expectedHandoff ? "应转人工" : `应命中 ${f.expectedDoc}`;
    console.log(`  ${f.id}  ${f.question}  →  ${want}，实际 ${got}（top ${f.topScore.toFixed(2)} / 覆盖 ${(f.topCoverage * 100).toFixed(0)}%）`);
  }
}

// ---------- 回答层 ----------
let answerMetrics = null;
if (live) {
  const key = loadKey();
  const normalize = (s) => s.toLowerCase().replace(/[\s\u3000]/g, "");

  console.log(`\n=== 回答层评测（调用 DeepSeek，共 ${rows.length} 次）===\n`);
  const results = [];

  for (const row of rows) {
    const system = buildSystemPrompt(row.question, row);
    let answer = "";
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0,
          max_tokens: 400,
          messages: [
            { role: "system", content: system },
            { role: "user", content: row.question },
          ],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      answer = json.choices?.[0]?.message?.content ?? "";
    } catch (error) {
      console.log(`  ${row.id}  请求失败：${error.message}`);
      results.push({ id: row.id, ok: false, answer: "", error: error.message });
      continue;
    }

    const item = set.items.find((i) => i.id === row.id);
    let ok;
    if (item.doc === null) {
      ok = /人工|订单号/.test(answer);
    } else {
      ok = (item.mustInclude ?? []).every((kw) => normalize(answer).includes(normalize(kw)));
    }

    results.push({ id: row.id, ok, answer });
    console.log(`  ${row.id}  ${ok ? "✅" : "❌"}  ${row.question}`);
    if (!ok) console.log(`      回答：${answer.replace(/\n/g, " ").slice(0, 120)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const answerIn = results.filter((r) => {
    const item = set.items.find((i) => i.id === r.id);
    return item.doc !== null;
  });
  const answerOut = results.filter((r) => {
    const item = set.items.find((i) => i.id === r.id);
    return item.doc === null;
  });

  answerMetrics = {
    factAccuracy: answerIn.filter((r) => r.ok).length / answerIn.length,
    handoffAccuracy: answerOut.filter((r) => r.ok).length / answerOut.length,
    hallucinationRate: 1 - answerIn.filter((r) => r.ok).length / answerIn.length,
  };

  console.log(`\n事实准确率   ${pct(answerMetrics.factAccuracy * answerIn.length, answerIn.length)}  (${answerIn.filter((r) => r.ok).length}/${answerIn.length})`);
  console.log(`拒答正确率   ${pct(answerMetrics.handoffAccuracy * answerOut.length, answerOut.length)}  (${answerOut.filter((r) => r.ok).length}/${answerOut.length})`);
  console.log(`幻觉率       ${pct(answerMetrics.hallucinationRate * answerIn.length, answerIn.length)}（1 - 事实准确率）`);
}

// ---------- 落盘 ----------
const report = {
  ranAt: new Date().toISOString(),
  model: live ? "deepseek-chat" : null,
  indexBuiltAt: index.builtAt,
  chunkCount: index.chunkCount,
  thresholds: { MIN_SCORE, MIN_COVERAGE, TOP_K },
  retrieval: retrievalMetrics,
  answer: answerMetrics,
  failures: failures.map((f) => ({
    id: f.id,
    question: f.question,
    expectedDoc: f.expectedDoc,
    topDoc: f.topDoc,
    score: Math.round(f.topScore * 100) / 100,
    coverage: Math.round(f.topCoverage * 100) / 100,
  })),
};

const outDir = join(root, "data/eval");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "latest-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(`\n报告已写入 data/eval/latest-report.json${live ? "" : "（回答层需加 --live）"}`);

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) throw new Error("缺少 .env.local");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(".env.local 中没有 DEEPSEEK_API_KEY");
}
