/**
 * Markdown 知识库切分器
 *
 * 设计原则（详见 README · 路线图 v0.3）：
 * - 政策类文档按「## 小节」切，保证一条规则不被切断
 * - 超过长度上限的小节按行合并切分，不切断单行（SKU 一行一条依赖此特性）
 * - 保留 docTitle + section 作为检索元数据，回答时可溯源
 */

export type Chunk = {
  id: string;
  docId: string;
  docTitle: string;
  section: string;
  text: string;
};

/** 单条 chunk 的字符上限。政策条款 300-500 字为宜，过长会稀释检索信号 */
const MAX_SECTION_CHARS = 480;

/**
 * 小节超长时按行切分。
 * 单行本身超长（几乎不会出现）时按字符硬切，避免死循环。
 */
function splitOversize(text: string): string[] {
  if (text.length <= MAX_SECTION_CHARS) return [text];

  const pieces: string[] = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    if (line.length > MAX_SECTION_CHARS) {
      if (buffer.trim()) pieces.push(buffer.trim());
      buffer = "";
      for (let i = 0; i < line.length; i += MAX_SECTION_CHARS) {
        pieces.push(line.slice(i, i + MAX_SECTION_CHARS));
      }
      continue;
    }
    if (buffer.length + line.length + 1 > MAX_SECTION_CHARS && buffer.trim()) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    buffer += (buffer ? "\n" : "") + line;
  }
  if (buffer.trim()) pieces.push(buffer.trim());

  return pieces;
}

/** 把一篇 Markdown 切成若干 chunk */
export function chunkMarkdown(docId: string, raw: string): Chunk[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const chunks: Chunk[] = [];

  let docTitle = docId;
  let section = "概述";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    for (const piece of splitOversize(text)) {
      chunks.push({
        id: `${docId}#${chunks.length + 1}`,
        docId,
        docTitle,
        section,
        text: piece,
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      docTitle = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      section = line.slice(3).trim();
      continue;
    }
    // 引用块是文档级元信息（适用范围/生效日期），不进入检索正文，避免污染相似度
    if (line.startsWith(">")) continue;
    buffer.push(line);
  }
  flush();

  return chunks;
}
