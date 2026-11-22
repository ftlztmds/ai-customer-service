// 测量 DeepSeek 流式首 token 延迟（真实端到端，含网络往返）
// 用法：node scripts/measure-latency.mjs
// 可选环境变量：MODEL / ROUNDS / PROMPT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  let raw;
  try {
    raw = readFileSync(join(root, ".env.local"), "utf8");
  } catch {
    throw new Error("读不到 .env.local，请先按 .env.example 创建它");
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(".env.local 里没有 DEEPSEEK_API_KEY");
}

const KEY = loadKey();
const MODEL = process.env.MODEL || "deepseek-chat";
const PROMPT = process.env.PROMPT || "怎么退换货？";
const ROUNDS = Number(process.env.ROUNDS || 10);

if (typeof fetch !== "function") {
  console.error("需要 Node.js 18+（当前版本没有全局 fetch）");
  process.exit(1);
}

async function once() {
  const t0 = performance.now();
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "你是一名专业、热情、有耐心的宠物跨境电商店铺金牌客服。回答一律使用纯文本，不要输出 Markdown 标记。",
        },
        { role: "user", content: PROMPT },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstToken = null;
  let chars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstToken === null) firstToken = performance.now() - t0;
        chars += delta.length;
      }
    }
  }

  return { firstToken, total: performance.now() - t0, chars };
}

const pick = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (arr) => pick(arr, 50);
const ms = (n) => `${n.toFixed(0)} ms`;

console.log(`模型 ${MODEL} · 网络 ${ROUNDS} 轮 + 1 轮预热\n`);

// 预热：排除 TCP/TLS 握手的一次性开销，避免第一轮虚高
await once();

const rows = [];
for (let i = 1; i <= ROUNDS; i++) {
  const r = await once();
  rows.push(r);
  console.log(
    `#${String(i).padStart(2, "0")}  首token ${ms(r.firstToken).padStart(8)}   全程 ${ms(r.total).padStart(8)}   ${r.chars} 字`,
  );
}

const ft = rows.map((r) => r.firstToken);
const tt = rows.map((r) => r.total);

console.log(
  `\n首 token 延迟：中位数 ${ms(median(ft))} · p90 ${ms(pick(ft, 90))} · 最快 ${ms(Math.min(...ft))} · 最慢 ${ms(Math.max(...ft))}`,
);
console.log(`整段生成耗时：中位数 ${ms(median(tt))}`);
console.log(`\n建议简历写法：首 token 响应中位数约 ${(median(ft) / 1000).toFixed(2)}s（${ROUNDS} 次采样，deepseek-chat）`);
