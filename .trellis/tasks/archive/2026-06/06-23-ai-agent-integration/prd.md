# brainstorm: AI Agent 集成 - 智能话题记录与总结

## Goal

在扩展中集成 AI Agent 能力。用户配置 OpenAI 兼容的 BaseURL + API Key 后，Agent 在刷帖过程中自动记录感兴趣的话题，并在结束后提供分类总结。

## What I already know

- 当前 popup 是单页面：状态栏 + 进度条 + 速度滑块 + 帖子数量 + 按钮
- 背景自动化通过 CDP 浏览帖子，`collectListInfo` 已能抓取话题标题和链接
- 用户希望只记录话题（topic title），不记录回复
- 用户设置偏好（如"AI资讯"、"福利"）来过滤记录哪些话题
- API 兼容 OpenAI 格式（BaseURL + API Key）
- 需要 `host_permissions` 或 `declarativeNetRequest` 来允许调用外部 API

## Decision (ADR-lite)

**Context 1**: Popup UI 布局方案
**Decision**: Tab 页签切换（浏览 / Agent / 总结）
**Consequences**: 每个 Tab 独立空间，整洁不拥挤；需要重构 popup.html 结构

**Context 2**: Agent 调用时机
**Decision**: 实时过滤 + 结束总结。每刷完一帖调 API 判断是否匹配偏好，匹配则记录；刷完后手动触发总结
**Consequences**: 每帖一次 API 调用（token 消耗），但过滤精准；总结时只处理匹配的话题，省 token

**Context 3**: 总结展示格式
**Decision**: Markdown 渲染。Agent 返回 Markdown 文本，前端用简单 markdown 渲染展示
**Consequences**: Agent 自由发挥格式，灵活；需要引入轻量 markdown 渲染（如 marked.js 或手写简单渲染）

**Context 4**: 存储容量
**Decision**: 继续用 `chrome.storage.local`，加自动清理策略（保留最近 100 条会话）
**Consequences**: 每条约 20KB（100 话题），100 条约 2MB，远低于 10MB 限制。超过自动删除最早的

## Requirements (evolving)

### Agent 配置（Tab: Agent）
- BaseURL 输入框（如 `https://api.openai.com/v1`）
- API Key 输入框（密码类型，带显示/隐藏切换）
- 偏好描述输入框（多行文本，自然语言，如"记录AI资讯和福利帖"）
- 测试连接按钮
- 全部持久化到 `chrome.storage.local`

### 话题记录流程（background.js）
- `startBrowse` 时创建新会话记录（带时间戳）
- 每刷完一个话题，调用 Agent API 判断是否匹配偏好
- 匹配则追加到当前会话的 `topics` 数组：`{ title, href }`
- 不匹配则跳过
- `stopBrowse` 或自然结束时，将会话写入 `agentSessions` 列表
- 当前会话也实时持久化（防 service worker 意外终止丢失数据）

### 总结与历史（Tab: 总结）
- 每次运行为一条会话记录：`{ id, startTime, topics: [{title, href}], summary }`
- 总结 Tab 顶部显示会话列表（时间 + 话题数量）
- 点击展开详情：话题列表 + 分类总结
- "生成总结"按钮：对选中会话的 topics 调 Agent 分类总结
- "清除"按钮：删除单条会话记录
- 会话记录持久化到 `chrome.storage.local`（key: `agentSessions`）

### UI 结构（Tab: 浏览）
- 保留现有：状态栏、进度条、速度、帖子数量、按钮
- 无变化

## Acceptance Criteria (evolving)

- [ ] 用户可配置 BaseURL + API Key
- [ ] 浏览过程中记录话题标题和链接
- [ ] 用户可设置偏好描述（自然语言）
- [ ] 刷帖结束后生成分类总结
- [ ] 总结在 popup 中展示

## Out of Scope (explicit)

- 记录帖子回复内容
- Agent 自动回复/互动
- 流式输出（SSE）

## Technical Notes

- manifest.json `host_permissions` 需添加 `<all_urls>` 或用户自定义 API host
- 方案：使用 `<all_urls>` 简单通用，或用 `declarativeNetRequest` 动态添加
- service worker 中 `fetch` 可直接调用外部 API（无需 CORS）
- `recordedTopics` 存 `chrome.storage.local`，每帖追加写入
- Agent API 调用封装为 `callAgent(messages)` 函数，复用于过滤和总结
- popup.css 需新增 Tab 样式 + Agent 表单样式 + 总结展示样式
