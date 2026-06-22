# brainstorm: LinuxDo auto-browse browser extension

## Goal

实现一个浏览器插件（Chrome Extension，Manifest V3），自动在单个标签页内浏览 LinuxDo 论坛帖子。模拟真人浏览行为：打开帖子 → 缓慢滚动至底部 → 返回列表 → 打开下一个帖子，循环执行。

## What I already know

* LinuxDo (linux.do) 是一个基于 Discourse 的技术社区论坛
* 用户希望在单个标签页内完成所有操作，不新开标签页
* 浏览流程：点开帖子 → 慢慢向下滚动到底 → 返回 → 下一个帖子 → 重复
* 参考 kimi-webbridge 的浏览器控制能力（content script 注入方式）
* 这是一个全新项目，目录下没有任何代码

## Assumptions (temporary)

* LinuxDo 基于 Discourse，有标准的 API（/latest.json, /t/{id}.json）
* 用户主要想刷"最新"或"未读"帖子列表
* Chrome Extension Manifest V3 是目标平台
* 通过 content script 直接操作页面 DOM 实现，不需要外部服务
* 需要一个 popup 或 side panel 来控制启停

## Open Questions

* 需要过滤帖子类型/分类吗？（MVP 不需要）
* 是否需要模拟登录态管理？（MVP 不需要，依赖浏览器已登录）

## Requirements (evolving)

* Chrome Extension Manifest V3
* 单标签页运行，不新开标签页
* 从 /latest 最新帖子列表开始
* 自动按顺序浏览列表中的帖子
* 模拟慢速滚动行为（模拟真人阅读）
* 帖子内缓慢滚动到底部（触发加载更多）
* 滚动完成后自动返回帖子列表
* 自动点击下一个帖子
* 自动翻页继续刷（直到没有更多页面）
* 循环执行直到所有帖子浏览完毕或手动停止
* Popup 界面：启停控制按钮
* 错误处理：加载失败时跳过当前帖子继续下一个

## Acceptance Criteria (evolving)

* [ ] 插件能在 LinuxDo 页面上正常加载和运行
* [ ] 点击"开始"后自动从当前帖子列表开始浏览
* [ ] 帖子内缓慢滚动到底部（模拟真人阅读速度）
* [ ] 帖子内容过长时触发 Discourse 懒加载
* [ ] 滚动完成后自动返回帖子列表
* [ ] 自动点击下一个帖子
* [ ] 当前页帖子刷完后自动翻页
* [ ] 不会打开新标签页
* [ ] 有启停控制界面（popup）
* [ ] 加载失败时自动跳过并继续下一个
* [ ] 手动点击"停止"可随时中止

## Definition of Done

* Chrome Extension 可在 Chrome 中正常加载
* 在 linux.do/latest 页面点击"开始"后自动刷帖
* 模拟真人阅读行为（慢速滚动 + 随机停顿）
* 单标签页运行，全程不新开标签页
* README 说明安装和使用方法

## Out of Scope (explicit)

* 帖子内容的智能分析/筛选
* 自动回帖/点赞/互动
* 多标签页并行浏览
* Firefox/其他浏览器支持
* 后端服务/API 代理
* 已刷帖子记录/标记
* 分类过滤功能（后续可加）
* 定时任务/调度
* 浏览统计面板
* 登录态管理（依赖浏览器已有登录）

## Technical Approach

### 架构
Chrome Extension Manifest V3，三部分结构：

```
background.js (Service Worker)
  ├── 管理插件状态（运行/停止）
  └── 通过 chrome.runtime messaging 与 content script 通信

content.js (Content Script，注入 linux.do 页面)
  ├── 主循环：遍历帖子列表 → 点击帖子 → 滚动 → 返回
  ├── 滚动模拟：window.scrollBy() + 随机速度
  ├── DOM 操作：点击链接、检测加载状态
  └── 报告状态给 background

popup.html / popup.js (控制界面)
  └── 开始/停止按钮 + 状态显示
```

### 核心浏览循环
1. 在 `/latest` 帖子列表页面，获取所有 `.topic-list-item` 链接
2. 依次点击每个帖子链接（Discourse SPA 内部路由，不会新开标签）
3. 等待帖子内容加载完成（`waitForElement('.topic-body')`）
4. 缓慢滚动：`window.scrollBy()` 每 50ms 滚 0.5-3px，加上随机抖动
5. 检测底部：`scrollY + innerHeight >= scrollHeight`，且位置不再变化
6. 帖子底部停留 2-5 秒（模拟阅读完毕）
7. `history.back()` 返回列表页
8. 等待列表页加载完成，继续下一个
9. 当前页刷完后，点击翻页按钮，继续下一页

### 人类行为模拟
- 滚动速度随机变化（0.5-3px / 50ms）
- 偶尔回滚一小段再继续
- 操作间随机延迟（1-5 秒）
- 停留时间与帖子长度成正比

### 文件结构
```
manifest.json
background.js
content.js
popup.html
popup.js
popup.css
icons/ (16, 48, 128px)
```

## Decision (ADR-lite)

**Context**: 需要选择是通过 DOM 操作还是 Discourse API 来获取帖子列表并浏览
**Decision**: 使用 DOM 操作方式 — content script 直接点击页面上的帖子链接
**Consequences**: 
- 优点：模拟真实浏览行为，计为真实阅读量，无需处理 API 认证
- 缺点：依赖 Discourse DOM 结构，如果 linux.do 定制主题可能需要调整选择器
- 备选：Discourse JSON API（`/latest.json`）只作为获取帖子列表的补充方案

## Technical Notes

### Research References
* [`research/linuxdo-structure.md`](research/linuxdo-structure.md) — LinuxDo is Discourse-based, has JSON API, Cloudflare protected, DOM selectors verified from existing extensions
* [`research/browser-automation-patterns.md`](research/browser-automation-patterns.md) — Content script architecture, scrolling patterns, Discourse SPA routing, anti-detection techniques

### Key Architecture Decisions
* **Content Script only** — 所有逻辑在 content script 中运行，无需后台服务
* **DOM click 方式** — 通过 DOM 点击帖子链接模拟真实浏览（不是用 API fetch，否则不算阅读量）
* **Discourse SPA** — 链接点击后通过 Ember 路由在同页面内导航，不会自动新开标签
* **Scroll 实现** — `window.scrollBy()` + 随机速度变化（0.5-3px/50ms）模拟真人阅读
* **帖子内加载更多** — Discourse 帖子初始只加载 ~20 条，需要检测并触发懒加载
* **Cloudflare** — content script 运行在已验证的页面中，不需要额外处理
* **MV3 Service Worker** — 长循环放在 content script 中，background worker 只负责状态协调

### DOM Selectors (Discourse 标准)
* 帖子列表项: `.topic-list-item`
* 帖子标题链接: `.topic-list-item .title a`, `.raw-topic-link`
* 帖子内容: `.topic-body`, `.cooked`, `#post_1`
* 加载更多: `.topic-list .spinner`, `#main-outlet .loading`
* 翻页: `.next-page a`, `.pagination .next a`

### Existing References
* [linuxdo-helper-extension](https://github.com/xiaohuihui202504/linuxdo-helper-extension) — 类似的 Chrome 扩展实现
* [Vimium](https://github.com/philc/vimium) — content script 滚动/点击/导航的参考
* [Surfingkeys](https://github.com/brookhong/Surfingkeys) — 高级 content script 模式参考
