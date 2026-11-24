"""Step 3：手写完整语义检索链路（不用任何框架）

切分 → 向量化 → 余弦比对 → 排序取 top3

和项目里 lib/knowledge/ 的 TypeScript 版一一对应，做完这一步你就知道
"向量检索"到底是什么，而不是"我调了个库"。
"""

import json
import math
import os
import re
import ssl
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def load_env() -> None:
    env_path = ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)$", line)
        if match:
            key, value = match.group(1), match.group(2).strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


load_env()

API_KEY = os.environ["EMBEDDING_API_KEY"]
BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")


# ---------------------------------------------------------------- 1. 切分
def split_markdown(path: Path) -> list[dict]:
    """按 '## ' 切小节；跳过 '>' 开头的引用块（和 TS 版 chunk.ts 策略一致）"""
    doc_title = path.stem
    section = "概述"
    buffer: list[str] = []
    chunks: list[dict] = []

    def flush() -> None:
        text = "\n".join(buffer).strip()
        buffer.clear()
        if text:
            chunks.append(
                {"doc_id": path.stem, "doc_title": doc_title, "section": section, "text": text}
            )

    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            flush()
            doc_title = line[2:].strip()
        elif line.startswith("## "):
            flush()
            section = line[3:].strip()
        elif line.startswith(">"):
            continue  # 文档级元信息，不进检索正文
        else:
            buffer.append(line)
    flush()
    return chunks


# ---------------------------------------------------------------- 2. 向量化
def embed(texts: list[str], batch: int = 16) -> list[list[float]]:
    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        context = ssl.create_default_context()

    vectors: list[list[float]] = []
    for start in range(0, len(texts), batch):
        part = texts[start : start + batch]
        body = json.dumps({"model": MODEL, "input": part}).encode("utf-8")
        request = Request(
            f"{BASE_URL}/embeddings",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
        )
        with urlopen(request, timeout=60, context=context) as response:
            payload = json.loads(response.read().decode("utf-8"))
        # 按 index 排序，防止向量与文本错位
        items = sorted(payload["data"], key=lambda d: d["index"])
        vectors.extend(item["embedding"] for item in items)
    return vectors


# ---------------------------------------------------------------- 3. 余弦检索
def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def search(query: str, chunks: list[dict], vectors: list[list[float]], k: int = 3) -> list[tuple]:
    query_vector = embed([query])[0]
    scored = [(cosine(query_vector, vec), chunk) for chunk, vec in zip(chunks, vectors)]
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:k]


# ---------------------------------------------------------------- main
if __name__ == "__main__":
    files = sorted((ROOT / "data" / "knowledge").glob("*.md"))
    chunks: list[dict] = []
    for file in files:
        chunks.extend(split_markdown(file))

    print(f"切分：{len(files)} 篇文档 → {len(chunks)} 条 chunk")
    vectors = embed([c["text"] for c in chunks])
    print(f"向量化：{len(vectors)} 条 × {len(vectors[0])} 维\n")

    for query in ["退货要花钱吗", "TL-DW-M 多少钱", "猫爬架承重多少"]:
        print(f"问：{query}")
        for score, chunk in search(query, chunks, vectors):
            print(f"   {score:.4f}  [{chunk['doc_id']}] {chunk['doc_title']} · {chunk['section']}")
        print()

    print("对照：'退货要花钱吗' 和原文没有任何共同词 —— BM25 找不到，向量能找到。")
