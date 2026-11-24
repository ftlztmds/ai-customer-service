"""Step 1：用 LangChain 的切分器处理一份知识库文档，看它怎么切。

目的：和我们手写的 lib/knowledge/chunk.ts 对比 —— 框架做了什么、漏了什么。
"""

from pathlib import Path

from langchain_text_splitters import MarkdownHeaderTextSplitter

splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=[("#", "doc_title"), ("##", "section")],
)

raw = Path("data/knowledge/01-退换货政策.md").read_text(encoding="utf-8")
chunks = splitter.split_text(raw)

print(f"切出 {len(chunks)} 条\n")
for i, chunk in enumerate(chunks, 1):
    print(f"[{i}] 元数据：{chunk.metadata}")
    print(f"    正文：{chunk.page_content[:70]!r}\n")
