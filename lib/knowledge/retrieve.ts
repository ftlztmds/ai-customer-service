/**
 * 知识库检索入口（Next.js 运行时使用）
 *
 * 索引在构建期生成（scripts/build-knowledge.mjs），通过 JSON import 打进产物，
 * 避免 serverless 环境下运行时读文件路径不确定的问题。
 *
 * 双闸门判定 grounded：
 *   1. BM25 分数 >= MIN_SCORE     —— 保证相关性
 *   2. 实词覆盖率 >= MIN_COVERAGE —— 过滤"蹭字面"的长问句
 * 只有同时满足才允许基于资料作答，否则一律转人工。这是控制幻觉的第一道闸。
 */

import indexJson from "../../data/knowledge/index.json";
import { createSearcher, MIN_COVERAGE, MIN_SCORE, type Hit } from "./scorer";

export type { Hit };

type KnowledgeIndex = {
  builtAt: string;
  chunkCount: number;
  chunks: Parameters<typeof createSearcher>[0];
};

const knowledgeIndex = indexJson as KnowledgeIndex;

const search = createSearcher(knowledgeIndex.chunks);

export type Retrieval = {
  /** 是否检索到足够可靠的资料，决定「基于资料回答」还是「转人工」 */
  grounded: boolean;
  hits: Hit[];
  query: string;
  topScore: number;
  topCoverage: number;
};

/** 默认只取 3 条：客服回答不需要 4 段资料，多一条就多一分噪声与成本 */
const DEFAULT_TOP_K = 3;

export function searchKnowledge(query: string, topK = DEFAULT_TOP_K): Retrieval {
  const hits = search(query, topK);
  const topScore = hits[0]?.score ?? 0;
  const topCoverage = hits[0]?.coverage ?? 0;

  return {
    grounded: topScore >= MIN_SCORE && topCoverage >= MIN_COVERAGE,
    hits,
    query,
    topScore,
    topCoverage,
  };
}

export { MIN_SCORE, MIN_COVERAGE };
