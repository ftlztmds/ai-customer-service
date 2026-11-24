"""Step 6（修订版）：分节粒度对比三路检索 + α 扫描

两处关键改动：
1. 修正评测集里 2 条 doc_id 写错（写成了 H1 标题，而代码用的是文件名）
2. 加 α 扫描 —— 之前固定 0.5 是拍脑袋的，要用数据选

性能注意：每条问题的向量只算一次，然后复用给所有 α。
否则 15 条 × 7 个 α 会发 105 次请求，浪费钱也慢。
"""

import json

from step3_search import ROOT, cosine, embed, split_markdown
from step4_bm25 import bm25_scores, tokenize
from step5_hybrid import minmax

ALPHAS = [0.0, 0.3, 0.5, 0.7, 0.85, 1.0]


def key(chunk: dict) -> tuple[str, str]:
    return chunk["doc_id"], chunk["section"]


def top_index(fused: list[float]) -> int:
    return max(range(len(fused)), key=lambda i: fused[i])


if __name__ == "__main__":
    chunks: list[dict] = []
    for file in sorted((ROOT / "data" / "knowledge").glob("*.md")):
        chunks.extend(split_markdown(file))
    docs_tokens = [tokenize(c["text"] + " " + c["section"]) for c in chunks]
    vectors = embed([c["text"] for c in chunks])

    items = json.loads((ROOT / "data" / "eval" / "paraphrase.json").read_text(encoding="utf-8"))["items"]
    print(f"口语化评测集 {len(items)} 条 · 分节粒度（{len(chunks)} 选 1）\n")

    # 先为每条问题算一次两路分数（向量只调一次 API）
    prepared = []
    for item in items:
        query_vector = embed([item["question"]])[0]
        prepared.append(
            {
                "item": item,
                "vec": minmax([cosine(query_vector, v) for v in vectors]),
                "bm": minmax(bm25_scores(item["question"], docs_tokens)),
            }
        )

    # ---------- 表 1：三种典型模式逐题对照 ----------
    modes = {"纯 BM25": 0.0, "混合 α=0.5": 0.5, "纯向量": 1.0}
    print(f"{'问题':<22}{'BM25':<24}{'混合':<24}{'向量'}")
    print("-" * 92)

    tally = {name: 0 for name in modes}
    for row in prepared:
        cells = []
        for name, alpha in modes.items():
            fused = [alpha * v + (1 - alpha) * b for v, b in zip(row["vec"], row["bm"])]
            best = chunks[top_index(fused)]
            hit = key(best) == key({"doc_id": row["item"]["doc"], "section": row["item"]["section"]})
            tally[name] += hit
            cells.append(("✅ " if hit else "❌ ") + best["section"])
        print(f"{row['item']['question']:<22}{cells[0]:<24}{cells[1]:<24}{cells[2]}")

    print("-" * 92)
    for name in modes:
        print(f"{name:<12} 小节命中率 {tally[name] / len(items) * 100:5.1f}%  ({tally[name]}/{len(items)})")

    # ---------- 表 2：α 扫描 ----------
    print(f"\n=== α 扫描（α=0 纯 BM25，α=1 纯向量）===")
    print(f"{'alpha':>6}  {'小节命中率':>10}")
    print("-" * 22)
    best = (-1.0, -1)
    for alpha in ALPHAS:
        hits = 0
        for row in prepared:
            fused = [alpha * v + (1 - alpha) * b for v, b in zip(row["vec"], row["bm"])]
            best_chunk = chunks[top_index(fused)]
            if key(best_chunk) == (row["item"]["doc"], row["item"]["section"]):
                hits += 1
        rate = hits / len(items)
        print(f"{alpha:>6.2f}  {rate * 100:>9.1f}%  ({hits}/{len(items)})")
        if rate > best[0]:
            best = (rate, alpha)

    print(f"\n最佳 α = {best[1]}（命中率 {best[0] * 100:.1f}%）")
    print("提醒：只有 15 条样本，1 条差异 = 6.7 个百分点，别过度解读。")
