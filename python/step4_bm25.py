"""Step 4：手写 BM25，和向量检索做对照

目的：亲眼看到两种检索各自的盲区
- BM25 强在精确词（型号 TL-DW-M、政策名"七天无理由"）
- BM25 弱在同义改写（"退货要花钱吗" 和原文没有共同词 → 找不到）

BM25 公式只有三个部分：
    score = Σ  IDF(词) × [ TF × (k1+1) ] / [ TF + k1 × (1 - b + b × 文档长度/平均长度) ]
        IDF  —— 词越罕见，权重越高（"德国"比"退货"有价值）
        TF   —— 词在这块里出现越多，分越高，但会被 k1 压制（防堆词）
        b    —— 长度归一化，长文档不占便宜
"""

import math
import re

# 复用 Step 3 里写好的切分 / 向量化 / 检索，避免重复代码
from step3_search import ROOT, embed, search, split_markdown

# ---------------------------------------------------------------- 分词
# 中文没有空格，先按虚词切段，再在段内取二元组（和 TS 版 scorer.ts 同思路）
CJK = re.compile(r"[\u4e00-\u9fa5]+")
ASCII_WORD = re.compile(r"[a-z0-9]+")
STOP_CHARS = set("的了吗呢啊吧呀么怎什我你您请问能要想个是有和与这那就都也还把被给让对从")
SPLIT = re.compile(f"[{''.join(STOP_CHARS)}]")


def tokenize(text: str) -> list[str]:
    lower = text.lower()
    tokens = [m.group(0) for m in ASCII_WORD.finditer(lower) if len(m.group(0)) >= 2]
    for match in CJK.finditer(lower):
        for segment in SPLIT.split(match.group(0)):
            for i in range(len(segment) - 1):
                tokens.append(segment[i : i + 2])
    return tokens


# ---------------------------------------------------------------- BM25
def bm25_scores(query: str, docs_tokens: list[list[str]], k1: float = 1.2, b: float = 0.75) -> list[float]:
    n = len(docs_tokens)
    avgdl = sum(len(d) for d in docs_tokens) / n

    df: dict[str, int] = {}
    for tokens in docs_tokens:
        for term in set(tokens):
            df[term] = df.get(term, 0) + 1

    def idf(term: str) -> float:
        return math.log(1 + (n - df.get(term, 0) + 0.5) / (df.get(term, 0) + 0.5))

    query_terms = [t for t in tokenize(query)]
    scores: list[float] = []
    for tokens in docs_tokens:
        tf: dict[str, int] = {}
        for term in tokens:
            tf[term] = tf.get(term, 0) + 1
        score = 0.0
        for term in query_terms:
            freq = tf.get(term, 0)
            if freq == 0:
                continue
            score += idf(term) * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * len(tokens) / avgdl))
        scores.append(score)
    return scores


if __name__ == "__main__":
    files = sorted((ROOT / "data" / "knowledge").glob("*.md"))
    chunks: list[dict] = []
    for file in files:
        chunks.extend(split_markdown(file))

    # BM25 索引：正文 + 小节名一起入索引（标题词很重要）
    docs_tokens = [tokenize(c["text"] + " " + c["section"]) for c in chunks]

    vectors = embed([c["text"] for c in chunks])
    print(f"就绪：{len(chunks)} 条 chunk，两种检索方式（BM25 / 向量）\n")

    for query in ["退货要花钱吗", "TL-DW-M 多少钱", "猫爬架承重多少"]:
        print(f"问：{query}")

        scores = bm25_scores(query, docs_tokens)
        bm25_ranked = sorted(zip(scores, chunks), key=lambda x: x[0], reverse=True)[:3]
        print("  BM25：")
        for score, chunk in bm25_ranked:
            print(f"    {score:7.2f}  {chunk['section']}")

        print("  向量：")
        for score, chunk in search(query, chunks, vectors):
            print(f"    {score:7.4f}  {chunk['section']}")
        print()

    print("观察点：'退货要花钱吗' 这句，BM25 的分数是不是明显很低甚至全 0？")
    print("因为它依赖字面重叠，而这句和原文没有共同词 —— 这就是必须做混合检索的原因。")
