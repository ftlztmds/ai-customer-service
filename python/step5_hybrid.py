"""Step 5：混合检索 + 评测对比

要做两件事：
1. 把 BM25 和向量两路分数**归一化后加权融合**（不归一化，BM25 的 7.72 会直接压死余弦的 0.62）
2. 用 32 道有答案的评测题，比较 纯BM25 / 纯向量 / 混合 的 Top-1 准确率

融合公式：
    score = α × 向量分 + (1 - α) × BM25 分
    α=0 纯 BM25，α=1 纯向量，α=0.5 各半
"""

import json
import time

from step3_search import ROOT, cosine, embed, split_markdown
from step4_bm25 import bm25_scores, tokenize


def minmax(values: list[float]) -> list[float]:
    """把一组分数压到 0~1，否则两路尺度不同没法相加"""
    lo, hi = min(values), max(values)
    if hi == lo:
        return [0.0] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


def top_docs(query: str, chunks, docs_tokens, vectors, alpha: float, k: int = 3) -> list[str]:
    """返回 top-k 的 doc_id 列表"""
    query_vector = embed([query])[0]

    vec_scores = [cosine(query_vector, vec) for vec in vectors]
    bm_scores = bm25_scores(query, docs_tokens)

    vec_norm = minmax(vec_scores)
    bm_norm = minmax(bm_scores)

    fused = [alpha * v + (1 - alpha) * b for v, b in zip(vec_norm, bm_norm)]
    order = sorted(range(len(fused)), key=lambda i: fused[i], reverse=True)[:k]
    return [chunks[i]["doc_id"] for i in order]


def evaluate(chunks, docs_tokens, vectors, questions: list[dict], alpha: float) -> tuple[float, float]:
    """返回 (Top-1 准确率, Hit@3 召回)"""
    in_scope = [q for q in questions if q["doc"]]
    top1 = hit3 = 0
    for item in in_scope:
        hits = top_docs(item["question"], chunks, docs_tokens, vectors, alpha)
        if hits and hits[0] == item["doc"]:
            top1 += 1
        if item["doc"] in hits:
            hit3 += 1
    return top1 / len(in_scope), hit3 / len(in_scope)


if __name__ == "__main__":
    files = sorted((ROOT / "data" / "knowledge").glob("*.md"))
    chunks: list[dict] = []
    for file in files:
        chunks.extend(split_markdown(file))

    docs_tokens = [tokenize(c["text"] + " " + c["section"]) for c in chunks]

    started = time.perf_counter()
    vectors = embed([c["text"] for c in chunks])
    print(f"{len(chunks)} 条 chunk 向量化完成，耗时 {(time.perf_counter() - started) * 1000:.0f} ms\n")

    questions = json.loads((ROOT / "data" / "eval" / "questions.json").read_text(encoding="utf-8"))["items"]
    print(f"评测集：{len([q for q in questions if q['doc']])} 条有答案的题\n")

    print(f"{'alpha':>6}  {'说明':<10} {'Top-1':>8} {'Hit@3':>8}")
    print("-" * 40)
    best = (0.0, -1.0, 0.0)
    for alpha in [0.0, 0.3, 0.5, 0.7, 1.0]:
        top1, hit3 = evaluate(chunks, docs_tokens, vectors, questions, alpha)
        label = {0.0: "纯 BM25", 1.0: "纯向量"}.get(alpha, "混合")
        print(f"{alpha:>6.1f}  {label:<10} {top1 * 100:>7.1f}% {hit3 * 100:>7.1f}%")
        if top1 > best[1]:
            best = (alpha, top1, hit3)

    print(f"\n最佳 alpha = {best[0]}（Top-1 {best[1] * 100:.1f}%，Hit@3 {best[2] * 100:.1f}%）")

    print("\n=== 最佳参数下的示例 ===")
    for query in ["退货要花钱吗", "TL-DW-M 多少钱", "猫爬架承重多少"]:
        docs = top_docs(query, chunks, docs_tokens, vectors, best[0])
        print(f"{query:14s} → {' / '.join(docs)}")

    print("\n说明：向量分与 BM25 分量纲不同（0~1 vs 无上界），必须先 minmax 归一化再相加。")
