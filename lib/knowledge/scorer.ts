/**
 * 检索打分核心（纯函数，无 I/O、无框架依赖）
 *
 * 拆出来的原因：这个文件可以同时被 Next.js 运行时和 node 调试脚本直接使用，
 * 不绑定打包器的 JSON 导入语义，便于单测与调参。
 *
 * 为什么先用 BM25 而不是向量检索：
 * 1. DeepSeek 官方没有 embedding 接口，接向量需要引入第二家供应商与额外成本
 * 2. 客服知识库的查询高度依赖精确词（型号 TL-DW-M、「7 天无理由」），
 *    BM25 在这类精确匹配上优于纯语义检索，且零依赖、零网络、可离线
 * 3. 后续接入 embedding 时，只需在 search() 里增加一路打分做融合（混合检索）
 *
 * 中文分词：不引入 jieba 词典，改用「单字 + 二元组（bigram）」，
 * BM25 的 IDF 会自然压低高频单字权重，对客服短句足够。
 */

import type { Chunk } from "./chunk";

export type { Chunk };

export type Hit = {
  chunk: Chunk;
  score: number;
  matched: string[];
  /**
   * 查询「实词」被该 chunk 覆盖的比例（0-1）。
   * BM25 原始分随问句长度单调上升，单靠分数阈值会把长问句里的无关 chunk 放进来，
   * 覆盖率是长度无关的兜底信号。
   */
  coverage: number;
};

type Entry = {
  chunk: Chunk;
  tf: Map<string, number>;
  len: number;
};

const K1 = 1.2;
const B = 0.75;

/** 低于该分数视为「没有相关资料」，直接转人工，避免拿无关片段硬答 */
export const MIN_SCORE = 2.5;

/** 实词覆盖率下限：低于该值说明只是在蹭字面，不该当作依据 */
export const MIN_COVERAGE = 0.33;

/**
 * 虚词/疑问词字表：这些字只作为"切段符"，不参与覆盖率计算。
 * 注意「会」不在其中——它在「会员」「优惠」里是实词的一部分，
 * 当作疑问词会把「会员有什么优惠」误判成无资料。
 */
const STOP_CHARS = new Set("的了吗呢啊吧呀么怎什我你您请问能要想个是有和与这那就都也还把被给让对从".split(""));

/** 预编译切段正则，避免每次调用重建 */
const STOP_PATTERN = new RegExp(`[${[...STOP_CHARS].join("")}]`, "g");

const ASCII_WORD = /[a-z0-9]+/g;
const CJK_RUN = /[\u4e00-\u9fa5]+/g;

/** 中文用 1-gram + 2-gram，英文/型号用整词 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(ASCII_WORD)) tokens.push(match[0]);

  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 提取「实词」：英文/型号取整词，中文先按虚词切段、再在段内取二元组。
 *
 * 先切段再取二元组是关键：否则「会员有什么优惠」会产生「员有」「么优」这类
 * 跨词碎片，既拉低覆盖率，又把真命中误杀成"无资料"。
 */
export function contentTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const terms: string[] = [];

  for (const match of lower.matchAll(ASCII_WORD)) {
    if (match[0].length >= 2) terms.push(match[0]);
  }

  for (const match of lower.matchAll(CJK_RUN)) {
    const segments = match[0].split(STOP_PATTERN);
    for (const segment of segments) {
      for (let i = 0; i + 1 < segment.length; i++) terms.push(segment.slice(i, i + 2));
    }
  }

  return [...new Set(terms)];
}

/**
 * 只保留对问题有实词覆盖的片段。
 *
 * 覆盖率 0 的片段虽然靠单字也能蹭到分数，但它对回答没有贡献，
 * 放进上下文只会增加噪声与成本（例如问「意大利能发货吗」却塞进「运费规则」）。
 * 保留 top1 兜底，是为了让"全为 0"时仍能走下闸门判定并转人工。
 */
export function filterHits(hits: Hit[]): Hit[] {
  if (hits.length === 0) return hits;
  const kept = hits.filter((hit) => hit.coverage > 0);
  return kept.length > 0 ? kept : hits.slice(0, 1);
}

function buildEntries(chunks: Chunk[]): Entry[] {
  return chunks.map((chunk) => {
    // 标题与小节名做 2 倍加权：用户常直接问章节名（「退换货流程」「尺码怎么选」），
    // 标题命中的信号比正文里顺带提一句更可靠
    const titleTerms = tokenize(`${chunk.docTitle} ${chunk.section}`);
    const bodyTerms = tokenize(chunk.text);
    const terms = [...titleTerms, ...titleTerms, ...bodyTerms];

    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    return { chunk, tf, len: terms.length };
  });
}

export function createSearcher(chunks: Chunk[]) {
  const entries = buildEntries(chunks);
  const total = entries.length;

  const df = new Map<string, number>();
  for (const entry of entries) {
    for (const term of entry.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const avgLen = entries.reduce((sum, entry) => sum + entry.len, 0) / Math.max(total, 1);

  const idf = (term: string) => {
    const n = df.get(term) ?? 0;
    return Math.log(1 + (total - n + 0.5) / (n + 0.5));
  };

  return function search(query: string, topK = 4): Hit[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    const trimmed = query.trim().toLowerCase();
    const content = contentTerms(query);

    const scored = entries.map((entry) => {
      let score = 0;
      const matched: string[] = [];

      for (const term of queryTerms) {
        const freq = entry.tf.get(term);
        if (!freq) continue;
        matched.push(term);
        score += (idf(term) * (freq * (K1 + 1))) / (freq + K1 * (1 - B + (B * entry.len) / avgLen));
      }

      // 短语整体命中（完整问句出现在文档中）额外加权
      if (trimmed.length >= 2 && entry.chunk.text.toLowerCase().includes(trimmed)) {
        score *= 1.3;
      }

      const covered = content.filter((term) => entry.tf.has(term)).length;
      const coverage = content.length > 0 ? covered / content.length : 0;

      return { chunk: entry.chunk, score, matched, coverage };
    });

    return scored
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  };
}
