# VN Shop AI 客服助手（Chrome 扩展）

在 TikTok Shop 卖家中心聊天页注入一个浮动面板：读取买家最后一条消息 → 生成越南语推荐回复 + 中文对照 → 一键填入输入框。

**不会自动发送**：只填草稿，发送按钮始终由你点。

## 安装（约 2 分钟）

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `E:\ai-demo\extension` 这个文件夹
4. 打开卖家中心聊天页：`https://seller.tiktokshopglobalselling.com/chat/inbox`
5. 右下角出现「AI 客服助手」面板

## 首次设置

1. 点面板上的「设置」
2. 填入 DeepSeek API Key（`sk-...`），点「保存 Key」
3. Key 保存在本机 `chrome.storage.local`，**不写进代码、不上传**

## 使用

1. 打开某个买家会话
2. 点「读取并生成」
3. 面板会显示：
   - 买家原文（越南语）
   - 买家中文意思
   - 推荐回复（越南语）
   - 回复的中文意思 ← **发送前先看这一栏**
   - 意图 / 缺失信息
4. 确认无误后点「填入输入框」，再手动点发送

## 设计边界（刻意为之）

| 不做 | 原因 |
| --- | --- |
| 不自动点发送 | 错答的业务成本高于省下的人力；也避免被平台判定为自动化 |
| 不抓 cookie、不调未授权接口 | 只读页面上已经展示给你的内容 |
| 不上传会话历史 | 只有「当前这一条 + 最近 4 条上文」发给模型 |

## 已知限制

- 依赖页面 DOM 类名（`.chatd-bubble-main--other`、`[data-testid="chat.chatroom.trans_chat_input"]`）；TikTok 改版可能失效，改 `content.js` 顶部的 `SELECTORS` 即可
- 商品与库存目前写在 `background.js` 的 `DEFAULT_PRODUCTS` 里，需要换成你真实的 SKU
- 一次只处理单条消息，暂不支持多轮工具循环（在 CLI 版 `scripts/support-agent.mjs` 里实现了）

## 后续可做

1. 商品上下文：读取当前商品页名称/价格，自动带入提示词
2. 真实库存：把 `DEFAULT_PRODUCTS` 换成可编辑的配置页
3. 采纳率统计：记录「生成→填入→实际发送」的比例，用于评估效果
