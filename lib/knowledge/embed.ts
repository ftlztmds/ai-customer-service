/**
 * 文本向量化（Embedding）
 *
 * 作用：把一段文本压成一串数字（bge-m3 是 1024 维），
 * 语义相近的两段文本，向量之间的夹角就小 → 用余弦相似度衡量"意思像不像"。
 *
 * 为什么单独一个文件：Day 2 的混合检索会复用它，评测脚本也要用它，
 * 不能让调用方各自写一遍 fetch。
 */

/** 一次送多少条。太大容易超时/413，太多次往返浪费延迟 */
const BATCH_SIZE = 16;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请检查 .env.local`);
  }
  return value;
}

export function embeddingConfig() {
  return {
    baseUrl: (process.env.EMBEDDING_BASE_URL ?? "https://api.siliconflow.cn/v1").replace(/\/$/, ""),
    model: process.env.EMBEDDING_MODEL ?? "BAAI/bge-m3",
  };
}

type EmbeddingApiItem = { index: number; embedding: number[] };

/**
 * 批量向量化。
 * 返回的数组与入参顺序严格一一对应（即使接口返回乱序也按 index 排回来）。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = requireEnv("EMBEDDING_API_KEY");
  const { baseUrl, model } = embeddingConfig();
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: batch }),
    });

    if (!response.ok) {
      // 一定要把响应体打出来，否则只有 "fetch failed" 根本没法排查（401/404/413 全靠它）
      const body = await response.text().catch(() => "");
      throw new Error(
        `embedding 请求失败 ${response.status} ${response.statusText}：${body.slice(0, 500)}`,
      );
    }

    const json = (await response.json()) as { data?: EmbeddingApiItem[] };
    const items = json.data ?? [];
    if (items.length !== batch.length) {
      throw new Error(`返回条数不匹配：期望 ${batch.length}，实际 ${items.length}`);
    }

    // 按 index 复原顺序，避免向量和文本错位（错位后检索会莫名其妙地不准）
    for (const item of [...items].sort((a, b) => a.index - b.index)) {
      vectors.push(item.embedding);
    }
  }

  return vectors;
}

/** 余弦相似度：值域 [-1, 1]，越大越像。先除模长，结果不受向量长度影响 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不一致：${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
