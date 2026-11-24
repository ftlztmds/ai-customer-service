"""Step 7：用 LangChain 组件替换「向量化 + 存储 + 检索」，与手写版对比

控制变量：
- 切分仍用我们自己的 split_markdown（保证两边输入完全一致）
- 只替换三个环节：Embeddings、向量库、检索接口

要看三件事：
1. 两种实现的检索结果是否一致（一致性检验）
2. 命中率是否相同（如果差很多，说明哪里理解错了）
3. 代码量差多少、LangChain 帮你省了什么、又隐藏了什么
"""

import json
import time

from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_openai import OpenAIEmbeddings

from step3_search import API_KEY, BASE_URL, MODEL, ROOT, cosine, embed, split_markdown


def key(doc_id: str, section: str) -> tuple[str, str]:
    return doc_id, section


if __name__ == "__main__":
    # ---------- 1. 切分（用我们自己的实现，保证输入一致）----------
    chunks: list[dict] = []
    for file in sorted((ROOT / "data" / "knowledge").glob("*.md")):
        chunks.extend(split_markdown(file))

    documents = [
        Document(
            page_content=c["text"],
            metadata={"doc_id": c["doc_id"], "section": c["section"], "doc_title": c["doc_title"]},
        )
        for c in chunks
    ]

    # ---------- 2. LangChain：Embeddings + Chroma ----------
    embeddings = OpenAIEmbeddings(
        model=MODEL,
        base_url=BASE_URL,
        api_key=API_KEY,
        check_embedding_ctx_length=False,   # 非 OpenAI 官方接口必须关掉，否则会按 tiktoken 切分报错
    )

    started = time.perf_counter()
    store = Chroma.from_documents(
        documents=documents,
        embedding=embeddings,
        persist_directory=str(ROOT / "python" / ".chroma"),
        collection_name="step7",
    )
    print(f"Chroma 建库完成：{len(documents)} 条，耗时 {(time.perf_counter() - started) * 1000:.0f} ms\n")

    # ---------- 3. 手写版向量（复用 Step 3）----------
    vectors = embed([c["text"] for c in chunks])

    # ---------- 4. 同一批问题，两边各跑一次 ----------
    items = json.loads((ROOT / "data" / "eval" / "paraphrase.json").read_text(encoding="utf-8"))["items"]

    print(f"{'问题':<22}{'LangChain':<24}{'手写':<24}{'一致'}")
    print("-" * 88)

    agree = lc_hit = hw_hit = 0
    for item in items:
        query = item["question"]
        expected = key(item["doc"], item["section"])

        lc_doc = store.similarity_search(query, k=1)[0]
        lc = key(lc_doc.metadata["doc_id"], lc_doc.metadata["section"])

        query_vector = embed([query])[0]
        scores = [cosine(query_vector, vector) for vector in vectors]
        best = max(range(len(scores)), key=lambda i: scores[i])
        hw = key(chunks[best]["doc_id"], chunks[best]["section"])

        same = lc == hw
        agree += same
        lc_hit += lc == expected
        hw_hit += hw == expected

        print(f"{query:<22}{lc[1]:<24}{hw[1]:<24}{'✅' if same else '❌'}")

    total = len(items)
    print("-" * 88)
    print(f"两版结果一致率   {agree / total * 100:5.1f}%  ({agree}/{total})")
    print(f"LangChain 命中率 {lc_hit / total * 100:5.1f}%  ({lc_hit}/{total})")
    print(f"手写版   命中率  {hw_hit / total * 100:5.1f}%  ({hw_hit}/{total})")

    print("\n对照结论：")
    print("1. 一致率高 → 两套实现等价，LangChain 省的是代码，不是能力")
    print("2. LangChain 仍缺：拒答闸门、中文 BM25 分词、混合打分 —— 这三块都要自己补")
