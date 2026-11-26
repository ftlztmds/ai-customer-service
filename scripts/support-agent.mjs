// 越南站客服 Agent（工具路由 + 本地执行 + 模板回复）
// 用法：
//   node scripts/support-agent.mjs                     # 跑内置测试用例
//   node scripts/support-agent.mjs "sp này còn k ạ"    # 处理单条消息
//
// 为什么叫「Agent」而不是「分类器」：
//   模型不再只输出一个分类，而是输出「调用哪个工具 + 参数」，
//   由代码执行工具（查库存/抽槽位/给指引），再把结果组织成回复。
//   这就是最小可用的工具调用闭环：决策 → 执行 → 观察 → 回复。
//
// 成本设计：整条链路只调用模型 1 次（决策 + 抽槽位合并），
//   工具执行和措辞都在本地完成 —— 这是"能上生产"和"玩具 demo"的区别。

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) throw new Error("缺少 .env.local");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.*)$/);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(".env.local 里没有 DEEPSEEK_API_KEY");
}

const API_KEY = loadKey();

/**
 * 容错解析模型返回的 JSON。
 * 模型偶发会返回「两个对象粘连」或带前后缀的内容（例如 ...}{"type":"json_object"}），
 * 直接 JSON.parse 会抛错。这里截取第一个括号配平的 {...} 再解析 —— 生产环境必须这么兜。
 */
function parseModelJson(text) {
  if (!text) return null;
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续尝试截取
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const templates = JSON.parse(readFileSync(join(root, "data", "support", "engraving-templates.json"), "utf8")).templates;
const products = JSON.parse(readFileSync(join(root, "data", "support", "products.json"), "utf8")).items;

// ---------------------------------------------------------------- 工具（纯本地，零成本）
const tools = {
  /** 刻字：收集槽位 */
  engraving_slots: (args) => {
    const name = args.name_value?.trim() || null;
    const phone = args.phone_value?.trim() || null;
    let reply;
    if (name && phone) reply = `Dạ shop xác nhận: khắc tên ${name}, SĐT ${phone}. Bạn kiểm tra giúp shop nhé ạ!`;
    else if (name) reply = templates.ask_phone;
    else reply = templates.ask_name_phone;
    return { reply, observation: { name, phone } };
  },

  /** 刻字：操作指引 / 找入口 */
  engraving_guide: (args) => {
    const reply = args.guide_type === "find_entry" ? templates.find_entry : templates.how_to;
    return { reply, observation: { guide_type: args.guide_type ?? "how_to" } };
  },

  /** 查库存 */
  check_stock: (args, ctx) => {
    // 「sp này / cái này / này」是指代词，不能拿去匹配商品名 —— 要退回会话附带的商品上下文
    const GENERIC = ["sp này", "sản phẩm này", "cái này", "sp nay", "cai nay", "này", "sp này ạ"];

    const normalize = (text) => (text ?? "").toLowerCase().trim();
    let query = normalize(args.product);
    if (!query || GENERIC.some((word) => query.includes(word))) query = normalize(ctx?.product);

    const findProduct = (text) => {
      if (!text) return null;
      // 最长关键词优先：`vòng cổ mèo`(11 字符) 必须赢过 `vòng cổ`(7 字符)，
      // 否则猫项圈会被匹配成普通项圈
      let best = null;
      let bestLength = 0;
      for (const item of products) {
        for (const keyword of item.keywords) {
          const normalized = keyword.toLowerCase();
          if (text.includes(normalized) && normalized.length > bestLength) {
            best = item;
            bestLength = normalized.length;
          }
        }
        const namePrefix = item.name.toLowerCase().slice(0, 8);
        if (text.includes(namePrefix) && namePrefix.length > bestLength) {
          best = item;
          bestLength = namePrefix.length;
        }
      }
      return best;
    };

    // 先按解析出的词找；找不到再用会话上下文兜底
    const hit = findProduct(query) ?? findProduct(normalize(ctx?.product));

    if (!hit) {
      return {
        reply: "Dạ bạn muốn hỏi sản phẩm nào ạ? Bạn gửi giúp shop tên sản phẩm nhé ạ.",
        observation: { matched: null },
      };
    }

    if (hit.stock === "in_stock") {
      return {
        reply: `Dạ ${hit.name} còn hàng ạ, giá ${hit.price_vnd.toLocaleString("vi-VN")}đ. Bạn cho shop xin tên cần khắc nhé ạ.`,
        observation: { matched: hit.id, stock: hit.stock },
      };
    }
    if (hit.stock === "preorder") {
      return {
        reply: `Dạ ${hit.name} hiện đặt trước ạ, khoảng 3-5 ngày có hàng. Bạn muốn shop giữ giúp không ạ?`,
        observation: { matched: hit.id, stock: hit.stock },
      };
    }
    return {
      reply: `Dạ ${hit.name} tạm hết hàng ạ. Bạn để lại tên cần khắc, shop sẽ báo khi có hàng nhé ạ.`,
      observation: { matched: hit.id, stock: hit.stock },
    };
  },

  /** 物流异常：本地无订单 API，只能引导并提供单号 */
  shipping_status: () => ({
    reply:
      "Dạ shop xin lỗi vì sự bất tiện ạ. Bạn cho shop xin mã đơn hàng (hoặc số điện thoại đặt hàng) để shop kiểm tra với đơn vị vận chuyển nhé ạ.",
    observation: { needs_order_id: true },
  }),

  /** 感谢/好评 */
  acknowledge: () => ({
    reply: "Dạ shop cảm ơn bạn nhiều ạ! Bạn cần gì thêm cứ nhắn shop nhé ạ.",
    observation: { kind: "thanks" },
  }),

  /** 拿不准 → 转人工 */
  handoff: () => ({
    reply: "Dạ shop đã ghi nhận, bạn chờ shop kiểm tra và phản hồi lại ngay nhé ạ.",
    observation: { handoff: true },
  }),
};

// ---------------------------------------------------------------- 决策（唯一一次模型调用）
const system = `你是越南 TikTok Shop 店铺的客服决策器。根据买家消息，选择调用哪个工具，并抽取所需参数，只输出 JSON。

工具清单：
1. engraving_slots —— 买家要刻名字/电话，或在提供刻字信息。参数：name_value（要刻的名字原文，没有则 null）、phone_value（电话，没有则 null）
2. engraving_guide —— 买家问「怎么刻」「刻完怎么下单」→ guide_type="how_to"；买家说「没看到 / 在哪里」→ guide_type="find_entry"
3. check_stock —— 买家问是否有货。参数：product（买家提到的商品词，原文）
4. shipping_status —— 买家说没收到货、送错地址、快递问题
5. acknowledge —— 只是感谢或好评
6. handoff —— 其他情况（打招呼、问价格但没提商品、无法判断）

输出格式（只输出 JSON）：
{"tool":"engraving_slots","args":{"name_value":"Nâu","phone_value":null},"reason":"买家提供名字"}

注意：越南语常缩写（sđt/sđth = số điện thoại，sp = sản phẩm），按语义理解，不要臆造参数。`;

async function decide(message, context = [], productContext = null) {
  const contextBlock =
    (context.length ? `客服上文：\n${context.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
    (productContext ? `当前商品：${productContext}\n（买家说「sp này / cái này」时指的就是它）\n\n` : "");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${contextBlock}买家消息：${message}` },
      ],
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = await response.json();
  const raw = json.choices?.[0]?.message?.content ?? "";
  const parsed = parseModelJson(raw);

  if (!parsed) {
    console.error("[decide] 解析失败，模型原始返回：", JSON.stringify(raw).slice(0, 300));
    return { tool: "handoff", args: {}, reason: "解析失败：模型返回非 JSON" };
  }

  return { tool: parsed.tool ?? "handoff", args: parsed.args ?? {}, reason: parsed.reason ?? "" };
}

// ---------------------------------------------------------------- 单条处理
async function handle(message, context = [], productContext = null) {
  const decision = await decide(message, context, productContext);
  const executor = tools[decision.tool] ?? tools.handoff;
  const result = executor(decision.args ?? {}, { product: productContext });
  return { decision, ...result };
}

// ---------------------------------------------------------------- 入口
const cases = [
  { message: "sp này còn k ạ" },
  { message: "Hàng có sẵn không?" },
  { message: "Khắc cho mình tên Nâu nhé" },
  { message: "muốn khắc tên sđth" },
  { message: "Khắc tên như nào em" },
  { message: "có thấy đâu ạ", context: ["Bạn chỉ cần ghi chú nội dung bạn muốn khắc vào đơn hàng là được rồi."] },
  { message: "Tôi vẫn chưa nhận được đơn hàng của mình." },
  { message: "Cảm ơn shop" },
  { message: "alo b" },
];

const argv = process.argv.slice(2);
const productIndex = argv.indexOf("--product");
const productArg = productIndex >= 0 ? argv[productIndex + 1] : null;
const argMessage = argv.filter((a) => a !== "--product" && a !== productArg)[0];

if (argMessage) {
  const result = await handle(argMessage, [], productArg);
  console.log(`消息：${argMessage}`);
  console.log(`决策：${result.decision.tool}（${result.decision.reason}）`);
  console.log(`参数：${JSON.stringify(result.decision.args)}`);
  console.log(`观察：${JSON.stringify(result.observation)}`);
  console.log(`回复：${result.reply}`);
} else {
  console.log(`Agent 测试：${cases.length} 条消息\n`);
  const tally = {};
  for (const item of cases) {
    const result = await handle(item.message, item.context ?? []);
    tally[result.decision.tool] = (tally[result.decision.tool] ?? 0) + 1;
    console.log(`▸「${item.message}」`);
    console.log(`  工具：${result.decision.tool}　参数：${JSON.stringify(result.decision.args)}`);
    console.log(`  回复：${result.reply}\n`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.log("工具调用分布：", tally);
}
