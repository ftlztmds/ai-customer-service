// Service Worker：唯一持有 API Key 的地方（Key 存在 chrome.storage.local，不硬编码）
// 为什么放在这里：content script 发起的跨域请求会被 CORS 拦，
// 而扩展的 service worker 有 host_permissions，可以直连 api.deepseek.com。

const SYSTEM = `你是越南 TikTok Shop 店铺的客服助手。店铺主营【定制刻字饰品】（项圈、手链、名牌）。

【重要】翻译要求：
1. buyer_zh 必须是「忠实直译」，保留数字、型号、颜色、数量，不要概括、不要省略、不要补全。
2. 越南语常见缩写必须按语义还原：k/ko = không（不）、sp = sản phẩm（产品）、sđt/sđth = số điện thoại（电话）、
   fai = phải（对/必须）、vs = với（和）、r/ròi = rồi（了）、ib = inbox（私信）、oke = ok（好的）、
   ship = giao hàng（配送）、mik/mình = 我、bạn = 你、shop = 店铺。
3. 语气词（ạ / nhé / ạ nhé / dạ）不翻译成字面，但要在 buyer_tone 里说明语气（礼貌/催促/疑问）。
4. 如果原文有明显拼写错误，按最可能的原意翻译。

【术语表 · 必须使用下列译法，不要自由发挥】
- dây → 项链（这是首饰的链子，绝对不要译成「绳子」）
- vòng cổ → 项链
- vòng tay → 手链
- thẻ tên → 刻字名牌（宠物吊牌）
- khắc → 刻字
- tên → 名字
- sđt / sđth / số điện thoại → 电话号码
- màu → 颜色
- size → 尺码
- shop → 店铺
- mèo → 猫；chó → 狗
- 刻字内容里的名字（如 Nâu、meo、BIN、sữa、Mi）不翻译，保留原文

【输出 JSON，只输出 JSON】
{
  "buyer_zh": "忠实直译的中文（保留所有细节）",
  "buyer_tone": "语气：礼貌/催促/抱怨/疑问/感谢 中的一个",
  "buyer_intent": "一句话说明买家真正想要什么（结合上下文推断）",
  "intent": "engraving|stock|delivery|thanks|other",
  "reply_vi": "越南语推荐回复，1-2 句，礼貌（Dạ/ạ/shop/bạn），可直接发送",
  "reply_zh": "这条越南语回复的忠实中文翻译",
  "missing": ["还缺的信息，如 name / phone；没有就空数组"]
}

【回复规则】
1. 绝不编造库存、价格、时效——不知道就说会让客服核实。
2. 只有当买家在为下单提供信息时，缺名字/电话才礼貌追问（只问缺的）；仅仅确认做法时不要追问。
3. 买家问「怎么刻/怎么下单」时，说明：下单时在备注里写要刻的内容。
4. 买家只是在「确认某种做法」（例如「是刻在项链上对吧」）时：只做确认，不要主动索要电话号码等未提及的信息。
   只有当买家明确要下单、或已在提供信息时，才追问缺失字段。
5. 不要像机器人：一句话能说清就不要堆问题。
6. 不要用 markdown，不要输出解释。`;
const DEFAULT_PRODUCTS = [
  { name: "Vòng cổ khắc tên (da bò)", price: "199.000đ", stock: "còn hàng" },
  { name: "Vòng tay khắc tên", price: "149.000đ", stock: "còn hàng" },
  { name: "Thẻ tên cho thú cưng", price: "99.000đ", stock: "đặt trước 3-5 ngày" },
];

async function getSettings() {
  const data = await chrome.storage.local.get(["apiKey", "products"]);
  return {
    apiKey: data.apiKey ?? "",
    products: data.products?.length ? data.products : DEFAULT_PRODUCTS,
  };
}

async function generate({ message, history = [] }) {
  const { apiKey, products } = await getSettings();
  if (!apiKey) throw new Error("还没有设置 API Key（点面板上的「设置」填写）");

  const productBlock = products
    .map((p) => `- ${p.name}｜${p.price}｜${p.stock}`)
    .join("\n");

  const historyBlock = history.length ? `最近上文：\n${history.map((h) => `- ${h}`).join("\n")}\n\n` : "";

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `商品与库存：\n${productBlock}\n\n${historyBlock}买家最后一条消息：${message}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`接口 ${response.status}：${text.slice(0, 200)}`);
  }

  const json = await response.json();
  const raw = json.choices?.[0]?.message?.content ?? "{}";

  // 容错解析：模型偶发返回粘连 JSON
  let parsed = null;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  if (!parsed) throw new Error(`模型返回无法解析：${raw.slice(0, 200)}`);

  return {
    buyerZh: parsed.buyer_zh ?? "",
    buyerTone: parsed.buyer_tone ?? "",
    buyerIntent: parsed.buyer_intent ?? "",
    intent: parsed.intent ?? "other",
    replyVi: parsed.reply_vi ?? "",
    replyZh: parsed.reply_zh ?? "",
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
  };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "generate") {
    generate(request.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // 异步响应
  }

  if (request.type === "saveKey") {
    chrome.storage.local.set({ apiKey: request.apiKey }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === "saveProducts") {
    chrome.storage.local.set({ products: request.products }).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
