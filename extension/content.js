// Content script：在 TikTok Shop 卖家中心聊天页注入浮动面板
// 设计原则：
//   1. 只读页面已展示的内容（不抓 cookie、不调未授权接口）
//   2. 只填草稿到输入框，绝不自动点发送
//   3. 面板可折叠；读不到时输出调试信息，便于定位 DOM 变化

const PANEL_ID = "vn-shop-ai-panel";

const SELECTORS = {
  buyerBubble: ".chatd-bubble-main--other", // 买家气泡
  bubbleText: "pre", // 气泡内文本节点
  input: 'textarea[data-testid="chat.chatroom.trans_chat_input"]',
};

/** 越南语变音符号：用于判断哪条是原文（class 名是哈希值，不可靠） */
const VIETNAMESE = /[ăâđêôơưàạảãáằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/i;

const EXPAND_LABELS = ["查看原始消息", "查看原文", "显示原文", "原始消息", "原文"];

/**
 * 找到「当前正在看的会话」容器。
 * 为什么必须限定范围：这个页面是 SPA，收件箱里几十个会话的 DOM 都留在页面里（只是隐藏），
 * 全局 querySelectorAll 会拿到别的会话的消息 —— 表现为「读到的是另一单的内容」。
 * 锚点用输入框：输入框属于哪个面板，哪个面板就是当前会话。
 */
function getActiveScope() {
  const visibleInputs = [...document.querySelectorAll(SELECTORS.input)].filter(
    (node) => node.getClientRects().length > 0,
  );
  const input = visibleInputs[0];
  if (!input) return document.body;

  let node = input.parentElement;
  for (let depth = 0; depth < 15 && node; depth++) {
    if (node.querySelector(SELECTORS.buyerBubble)) return node;
    node = node.parentElement;
  }
  return document.body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBubbleTexts(bubble) {
  return [...bubble.querySelectorAll(SELECTORS.bubbleText)]
    .map((node) => node.textContent.trim())
    .filter(Boolean);
}

function findExpandButton(bubble) {
  const candidates = [...bubble.querySelectorAll("button, [role='button'], div, span, a")].filter(
    (node) => {
      const text = node.textContent?.trim();
      if (!text || text.length > 12) return false;
      return EXPAND_LABELS.some((label) => text === label || text.includes(label));
    },
  );
  // 优先取最内层节点（没有子元素的那个），点击才落到真正的处理元素上
  return candidates.sort((a, b) => a.children.length - b.children.length)[0] ?? null;
}

/**
 * 模拟真实用户点击。
 * React 组件常监听 pointerdown / mousedown，单独调用 .click() 不会触发。
 */
function clickLikeUser(node) {
  const rect = node.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    try {
      node.dispatchEvent(new EventClass(type, base));
    } catch {
      node.dispatchEvent(new MouseEvent(type, base));
    }
  }
}

function scanBubbles(limit = 3) {
  const scope = getActiveScope();
  const nodes = [...scope.querySelectorAll(SELECTORS.buyerBubble)].slice(-limit);
  return nodes.map((node) => ({ node, texts: readBubbleTexts(node) }));
}

/**
 * 读取最后一条买家消息。
 * 页面默认只渲染「翻译后的中文」，越南语原文要点「查看原始消息」才出现。
 * 策略：从最新气泡往前找越南语 → 找不到就点开原文 → 再找 → 都没有才退回中文。
 * 只点「查看原文」这类纯展示按钮，不触碰输入框和发送按钮。
 */
async function getLastBuyerMessage() {
  let scan = scanBubbles();
  if (!scan.length) return { text: "", source: "none", debug: "没有找到买家气泡" };

  const pickOriginal = () => {
    for (let i = scan.length - 1; i >= 0; i--) {
      const hit = scan[i].texts.find((text) => VIETNAMESE.test(text));
      if (hit) return hit;
    }
    return null;
  };

  const direct = pickOriginal();
  if (direct) return { text: direct, source: "original" };

  const button = findExpandButton(scan[scan.length - 1].node);
  if (button) {
    clickLikeUser(button);
    // 轮询等待：展开是异步渲染，固定 sleep 容易抢跑
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(350);
      scan = scanBubbles();
      const expanded = pickOriginal();
      if (expanded) return { text: expanded, source: "original-expanded" };
    }
  }

  return {
    text: scan[scan.length - 1].texts[0] ?? "",
    source: "translation",
    debug: `气泡数 ${scan.length}｜每条文本 ${JSON.stringify(scan.map((s) => s.texts))}｜展开按钮 ${button ? "有" : "无"}`,
  };
}

/** React 受控 textarea 必须用原生 setter + input 事件 */
function fillInput(text) {
  const input = document.querySelector(SELECTORS.input);
  if (!input) return false;

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  return true;
}

function buildPanel() {
  if (document.getElementById(PANEL_ID)) return;

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="vn-head">
      <span>AI 客服助手</span>
      <button class="vn-toggle" title="折叠">—</button>
    </div>
    <div class="vn-body">
      <div class="vn-row">
        <button class="vn-btn vn-primary" data-action="generate">读取并生成</button>
        <button class="vn-btn" data-action="settings">设置</button>
      </div>
      <section class="vn-block">
        <label>买家原文</label>
        <pre data-field="buyer"></pre>
      </section>
      <section class="vn-block">
        <label>买家中文意思</label>
        <p data-field="buyerZh" class="vn-muted"></p>
      </section>
      <section class="vn-block">
        <label>语气 / 真实意图</label>
        <p data-field="buyerIntent" class="vn-muted"></p>
      </section>
      <section class="vn-block">
        <label>推荐回复 · 越南语</label>
        <pre data-field="replyVi"></pre>
      </section>
      <section class="vn-block">
        <label>回复中文意思</label>
        <p data-field="replyZh" class="vn-muted"></p>
      </section>
      <section class="vn-block">
        <label>意图 / 缺失信息</label>
        <p data-field="meta" class="vn-muted"></p>
      </section>
      <div class="vn-row">
        <button class="vn-btn vn-primary" data-action="fill">填入输入框</button>
        <button class="vn-btn" data-action="copy">复制</button>
      </div>
      <p class="vn-tip">只填草稿，不自动发送。发送前请核对中文意思。</p>
      <div class="vn-settings" hidden>
        <label>DeepSeek API Key</label>
        <input type="password" data-field="apiKey" placeholder="sk-..." />
        <button class="vn-btn" data-action="saveKey">保存 Key</button>
        <p class="vn-tip">Key 只存本机 chrome.storage.local，不写进代码、不上传。</p>
      </div>
    </div>
  `;
  document.body.append(panel);

  const field = (name) => panel.querySelector(`[data-field="${name}"]`);

  panel.querySelector(".vn-toggle").addEventListener("click", () => {
    panel.classList.toggle("vn-collapsed");
  });

  panel.addEventListener("click", async (event) => {
    const action = event.target.dataset?.action;
    if (!action) return;

    if (action === "settings") {
      const box = panel.querySelector(".vn-settings");
      box.hidden = !box.hidden;
      return;
    }

    if (action === "saveKey") {
      const apiKey = field("apiKey").value.trim();
      const response = await chrome.runtime.sendMessage({ type: "saveKey", apiKey });
      field("apiKey").value = "";
      alert(response?.ok ? "已保存" : "保存失败");
      return;
    }

    if (action === "generate") {
      const { text: message, source, debug } = await getLastBuyerMessage();
      if (!message) {
        alert("没有读到买家消息，请确认已打开会话");
        return;
      }

      field("buyer").textContent =
        source === "translation"
          ? `${message}\n\n（仍是页面译文）\n调试：${debug ?? "-"}`
          : source === "original-expanded"
            ? `${message}\n\n（已自动展开原文）`
            : message;

      field("buyerZh").textContent = "生成中…";
      field("buyerIntent").textContent = "";
      field("replyVi").textContent = "生成中…";
      field("replyZh").textContent = "";
      field("meta").textContent = "";

      const response = await chrome.runtime.sendMessage({
        type: "generate",
        payload: { message, history: getRecentHistory() },
      });

      if (!response?.ok) {
        field("buyerZh").textContent = "";
        field("replyVi").textContent = `出错：${response?.error ?? "未知错误"}`;
        return;
      }

      const data = response.data;
      field("buyerZh").textContent = data.buyerZh;
      field("buyerIntent").textContent = [data.buyerTone, data.buyerIntent].filter(Boolean).join(" ｜ ");
      field("replyVi").textContent = data.replyVi;
      field("replyZh").textContent = data.replyZh;
      field("meta").textContent = `${data.intent}${data.missing?.length ? ` ｜ 缺：${data.missing.join(", ")}` : ""}`;
      return;
    }

    if (action === "fill") {
      const text = field("replyVi").textContent.trim();
      if (!text) return;
      alert(fillInput(text) ? "已填入输入框，请核对后手动发送" : "没找到输入框");
      return;
    }

    if (action === "copy") {
      const text = field("replyVi").textContent.trim();
      if (text) await navigator.clipboard.writeText(text);
    }
  });
}

function getRecentHistory(count = 4) {
  const scope = getActiveScope();
  const bubbles = [...scope.querySelectorAll(SELECTORS.buyerBubble)];
  return bubbles
    .slice(-count - 1, -1)
    .map((bubble) => bubble.innerText.trim().split("\n")[0])
    .filter(Boolean);
}

// SPA：切会话时 DOM 会重建，用 observer 保证面板一直在
const observer = new MutationObserver(() => {
  if (!document.getElementById(PANEL_ID) && document.body) buildPanel();
});

buildPanel();
observer.observe(document.documentElement, { childList: true, subtree: true });
