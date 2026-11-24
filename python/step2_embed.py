"""Step 2：不用任何框架，直接调 embedding 接口，看向量长什么样。

要观察三件事：
1. 一个向量有多少维（决定后面存储和计算的规模）
2. 向量里的数字是什么形态（正负小数，不是 0/1）
3. 相似的两句话余弦接近 1，不相关的接近 0
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
    """读取根目录 .env.local 里的 key（不覆盖已有环境变量）"""
    env_path = ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)$", line)
        if match:
            key, value = match.group(1), match.group(2).strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


load_env()

if not os.environ.get("EMBEDDING_API_KEY"):
    raise SystemExit("缺少 EMBEDDING_API_KEY，请检查项目根目录的 .env.local")

API_KEY = os.environ["EMBEDDING_API_KEY"]
BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")


def embed(texts: list[str]) -> list[list[float]]:
    """一次请求把多条文本变成向量（批量 = 省时间省钱）"""
    body = json.dumps({"model": MODEL, "input": texts}).encode("utf-8")
    request = Request(
        f"{BASE_URL}/embeddings",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
    )

    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        context = ssl.create_default_context()

    with urlopen(request, timeout=60, context=context) as response:
        payload = json.loads(response.read().decode("utf-8"))

    return [item["embedding"] for item in payload["data"]]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


if __name__ == "__main__":
    texts = [
        "德国退货要付运费吗",
        "德国非质量退货买家承担 4.99 欧元运费",
        "猫爬架承重上限 15 公斤",
    ]

    vectors = embed(texts)
    dim = len(vectors[0])

    print(f"模型：{MODEL}")
    print(f"返回 {len(vectors)} 条向量，每条 {dim} 维")
    print(f"前 5 个数字：{[round(n, 4) for n in vectors[0][:5]]}")
    print(f"数值范围：最小 {min(vectors[0]):.3f}  最大 {max(vectors[0]):.3f}\n")

    print("余弦相似度（越接近 1 越像）：")
    print(f"  ① vs ②（同话题）  {cosine(vectors[0], vectors[1]):.4f}")
    print(f"  ① vs ③（不同话题）{cosine(vectors[0], vectors[2]):.4f}")
