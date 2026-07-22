# claw

`claw` 是一个可以部署在 **Cloudflare Workers** 上的 Telegram 机器人，同时提供 **OpenAI 兼容接口**。  
它支持：

- Telegram 长对话和按钮交互
- 流式输出
- 自动网络搜索
- 自动网页抓取
- 隐式长期记忆
- 网页监控、运行模式切换和摘要卡
- 简体中文输出

这个项目的目标不是做一个“花里胡哨的壳”，而是做一个**能稳定跑在 Cloudflare 免费层附近**、适合长期维护的轻量 Agent。

## 一句话说明

你可以把 `claw` 理解成这样一条链路：

```text
Telegram / OpenAI 请求
→ Cloudflare Worker
→ 记忆整理 + 网页搜索 + 网页抓取
→ 模型回复
→ Telegram 流式编辑 / OpenAI 兼容返回
```

## 主要能力

- **Telegram 入口**
  - 支持普通消息
  - 支持 `callback_query` 按钮
  - 支持 `/start`、`/help`、`/model`、`/reset`、`/todo`、`/remind`、`/watch`、`/mode`、`/summary`
  - 支持真正的流式回复，不是只回最终结果

- **OpenAI 兼容接口**
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - 支持 `stream: true`

- **网络搜索**
  - 自动判断是否需要搜索当前信息、官网、文档、最新版本、价格、新闻等
  - 使用 DuckDuckGo 的 HTML 搜索页
  - 只取少量结果，避免把上下文撑爆

- **网页抓取**
  - 自动从用户消息里提取 `http://` / `https://` 链接
  - 抓取正文后转换成纯文本
  - 不依赖浏览器，不做 JS 渲染

- **长期记忆**
  - 按聊天单独保存
  - 隐式自动，不在 Telegram 里暴露“记忆管理 UI”
  - 自动压缩和合并老记忆
  - `/reset` 只清短期会话，不清长期记忆

## 项目结构

```text
claw/
├── src/index.js         # Worker 主入口，Telegram / OpenAI 接口都在这里
├── test/worker.test.js  # 核心行为测试
├── wrangler.jsonc       # Cloudflare Workers 配置
├── user.md              # 项目规则与偏好
└── soul.md              # 默认人格与语气
```

## 架构概览

### 请求流

```text
                           ┌─────────────────────┐
Telegram Webhook ────────▶ │ /telegram/webhook   │
OpenAI Clients ───────────▶ │ /v1/chat/completions│
                           │ /v1/models          │
                           └─────────┬───────────┘
                                     │
                                     ▼
                         ┌──────────────────────────┐
                         │ src/index.js             │
                         │ - 会话处理                │
                         │ - 搜索 / 抓取             │
                         │ - 长期记忆                │
                         │ - 流式回复                │
                         └─────────┬────────────────┘
                                   │
                   ┌───────────────┴───────────────┐
                   ▼                               ▼
      ┌─────────────────────────┐     ┌─────────────────────────┐
      │ Durable Object + SQLite  │     │ 上游 OpenAI-compatible  │
      │ 每个 chat 一份会话状态    │     │ 可选，未配置则走本地兜底  │
      └─────────────────────────┘     └─────────────────────────┘
```

### 关键实现点

- **Telegram 会话**
  - 每个 `chat_id` 对应一个 Durable Object 实例
  - 用 DO 的 SQLite 存储聊天历史、最后一轮提问、最后一轮回复和记忆
  - 这样按钮回调、重试和普通消息不会互相抢状态

- **上下文注入**
  - 发送给模型之前，会把长期记忆和网页上下文塞进隐藏 `system` 消息
  - 记忆优先级低于用户当前消息
  - Web 上下文和记忆都有限长，避免上下文失控

- **本地兜底**
  - 如果没有配置 `OPENAI_BASE_URL`，`/v1/chat/completions` 会走本地兜底逻辑
  - 这个兜底主要用于联调和最小可用，不是正式模型

## 快速开始

### 1. 克隆项目

```bash
git clone <repo-url>
cd claw
```

### 2. 安装依赖

```bash
npm install
```

当前 `package.json` 只有脚本，没有额外运行时依赖，但执行一次 `npm install` 仍然是推荐的，方便后续生成锁文件或扩展依赖。

### 3. 配置 Cloudflare 和 Telegram

这个项目最少需要下面这些配置：

#### 必填 secret

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

如果你要把请求转发到上游 OpenAI-compatible 服务，再加：

```bash
npx wrangler secret put OPENAI_API_KEY
```

#### 可选变量

`OPENAI_BASE_URL` 和模型名通常放在 Worker 的环境变量里。示例：

```jsonc
{
  "vars": {
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "CLAW_MODEL": "gpt-4.1-mini"
  }
}
```

说明：

- `CLAW_MODEL` 优先于 `OPENAI_MODEL`
- 如果都没配，默认模型名是 `claw-mini`
- `OPENAI_BASE_URL` 不填时，`claw` 仍能启动，但 OpenAI 兼容聊天会走本地兜底回复

### 4. 本地启动

```bash
npm run dev
```

`wrangler.jsonc` 已经包含 `TELEGRAM_SESSION` Durable Object 的绑定和 SQLite 存储声明，所以不需要你手动配数据库。

### 5. 部署

```bash
npm run deploy
```

### 6. 设置 Telegram Webhook

部署后，把 Telegram Webhook 指到：

```text
https://<your-worker-domain>/telegram/webhook
```

推荐带上 secret token：

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://<your-worker-domain>/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

## 配置说明

| 变量 / Secret | 必填 | 用途 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot API 访问令牌 |
| `TELEGRAM_WEBHOOK_SECRET` | 是 | webhook 校验用 secret token |
| `OPENAI_BASE_URL` | 否 | 上游 OpenAI-compatible 服务地址 |
| `OPENAI_API_KEY` | 否 | 上游接口鉴权用 Bearer token |
| `CLAW_MODEL` | 否 | 本项目优先使用的模型名 |
| `OPENAI_MODEL` | 否 | `CLAW_MODEL` 的备用来源 |

## Telegram 交互

### 命令

| 命令 | 作用 |
| --- | --- |
| `/start` | 显示帮助 |
| `/help` | 显示帮助 |
| `/model` | 查看当前模型、回复模式、流式状态 |
| `/reset` | 清空当前短期会话，不清长期记忆 |
| `/todo` | 管理待办事项 |
| `/remind` | 管理定时提醒 |
| `/watch` | 管理网页监控 |
| `/mode` | 查看或切换运行模式 |
| `/summary` | 查看会话摘要卡 |

### 按钮

| 按钮 | 作用 |
| --- | --- |
| `重试` | 用上一轮用户输入重新生成回复 |
| `重置` | 清空当前会话 |
| `帮助` | 打开帮助面板 |

### 行为特点

- 普通消息默认都当成提问
- 机器人会先发“思考中...”
- 然后把模型输出逐段编辑到同一条消息里
- 用户可见文案默认使用简体中文
- 交互风格会尽量直接，不堆废话

## OpenAI 兼容接口

### `GET /v1/models`

返回一个最小模型列表。

```bash
curl http://127.0.0.1:8787/v1/models
```

### `POST /v1/chat/completions`

支持标准 OpenAI 兼容请求体。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "claw-mini",
    "stream": true,
    "messages": [
      { "role": "user", "content": "你好，介绍一下你自己" }
    ]
  }'
```

#### 上游模式

如果配置了 `OPENAI_BASE_URL`：

- 请求会转发到上游 OpenAI-compatible 服务
- 会在用户消息前插入隐藏的系统上下文
- 上下文里会带上搜索结果和抓取结果
- 当前实现里，Telegram 长期记忆主要服务 Telegram 会话，不会自动注入到上游转发的 OpenAI-compatible 请求里

#### 本地兜底模式

如果没有配置 `OPENAI_BASE_URL`：

- 仍然可以调用 `/v1/chat/completions`
- 但回复是本地兜底内容，用于 smoke test 和最小可用
- 这个模式适合联调，不适合当正式模型

#### Telegram 入口的上下文

Telegram 会话会把以下内容一起送入模型上下文：

1. 长期记忆
2. 网页搜索结果
3. 网页抓取结果
4. 当前对话消息

其中长期记忆会被标记为“仅供参考，优先级低于用户当前消息”。

## 长期记忆

`claw` 的长期记忆是**隐式自动**的，不要求用户手动管理。

### 设计原则

- 只在消息看起来像稳定事实、偏好、地点、工作信息、联系人或明确指令时才抽取
- 不在 Telegram 里暴露记忆管理命令
- 记忆存储和短期对话分开
- `reset` 不会删除长期记忆

### 压缩策略

当记忆条数超过阈值时：

- 保留最近几条
- 更早的内容合并成一条摘要
- 摘要会去重
- 摘要长度会被截断，避免无限增长

这套策略是**规则驱动的压缩**，不是把整段历史丢给模型“自由发挥”。

## 网络搜索与网页抓取

### 搜索触发

当用户消息里出现类似下面的意图时，系统会尝试搜索：

- 搜索 / 查找 / 查询
- 最新 / 新闻 / 版本 / 更新
- 官网 / 文档 / 资料 / 价格 / 行情
- 互联网 / 网页

### 抓取触发

如果用户消息里带有 `http://` 或 `https://` 链接，会自动抓取这些网页。

### 实现方式

- 搜索使用 DuckDuckGo 的 HTML 页面
- 抓取使用普通 `fetch`
- 抓下来的 HTML 会被转换成纯文本
- 不依赖浏览器，也不执行网页 JavaScript

### 限制

- 搜索结果最多取 3 条
- 抓取 URL 最多取 2 个
- 注入到模型上下文中的网页内容会被截断
- 网络请求有超时保护

这意味着它更适合：

- 找资料
- 查官网
- 看文档
- 读公告

不适合：

- 需要登录态的网页
- 强依赖前端 JS 渲染的页面
- 特别长、特别重的抓取任务

## 开发与测试

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地启动 Worker |
| `npm test` | 运行测试 |
| `npm run deploy` | 部署到 Cloudflare Workers |

### 测试覆盖的核心场景

- 健康检查
- OpenAI 兼容本地回复
- OpenAI 兼容流式输出
- 上游 OpenAI-compatible 转发
- Telegram webhook secret 校验
- Telegram 发消息
- Durable Object 会话流转

## 文件说明

### `user.md`

项目级偏好和约束：

- Cloudflare Workers 目标
- Telegram / OpenAI-compatible 双入口
- 隐式长期记忆
- 简体中文输出
- 网络搜索和网页抓取

### `soul.md`

默认人格和语气：

- 幽默风趣的男高中生
- 简体中文
- 结论先行
- 可以活泼，但不能油腻

如果你要改项目行为，优先改 `user.md`。  
如果你要改说话风格，优先改 `soul.md`。

## 已知限制

- 没有配置上游模型时，本地回复只是兜底
- 网页抓取不渲染 JS
- 搜索和抓取都故意做了强限制，优先稳定和免费层可用
- 自动记忆是启发式规则，不是完整的语义分类系统

## 推荐阅读顺序

1. `README.md`
2. `wrangler.jsonc`
3. `src/index.js`
4. `test/worker.test.js`
5. `user.md`
6. `soul.md`
