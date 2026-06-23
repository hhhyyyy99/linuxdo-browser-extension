# brainstorm: 浏览器内存优化

## Goal

扩展运行时浏览器内存暴涨。需要定位内存增长原因并优化，使长时间刷帖不会导致浏览器卡死。

## What I already know

### 内存增长根因分析（按严重程度排序）

1. **BFCache 累积（高）** — `browseTopic` 每个帖子做全页导航。Chrome 的 Back/Forward Cache 保留每个之前页面的 DOM、图片、JS 状态。20-30 个帖子后可能累积 200MB-1.5GB。
2. **`Runtime.enable` / `Page.enable` 永不关闭（高）** — 整个会话期间保持活跃，Chrome 持续追踪并缓冲所有执行上下文事件和页面生命周期事件。
3. **autoScrollTopic 高频 CDP 调用（中）** — 每次循环 3 次 `evaluateInPage`（location check + scroll metrics + scrollBy），速度 2 时约 3000 次/分钟。
4. **图片/资源缓存增长（中）** — 每个帖子页面加载新图片，Chrome 图片缓存无上限增长。

### 核心修改文件

- `background.js` — 所有优化集中在此

## Requirements (evolving)

- 合并 autoScrollTopic 中每轮的 3 次 evaluateInPage 为 1 次（检查 URL + 读滚动 + 执行滚动）
- 不清理缓存（会拖慢后续加载）
- 不动 BFCache（影响小且清缓存得不偿失）

## Acceptance Criteria (evolving)

- [ ] 刷 50+ 帖子后浏览器内存稳定不暴涨
- [ ] 自动滚动流畅度不受明显影响

## Out of Scope (explicit)

- 图片懒加载拦截
- Service Worker 生命周期优化（keepalive 等）
- popup/content.js 优化（分析确认无问题）

## Technical Notes

- BFCache 清除方案：navigateTo('about:blank') 会让 Chrome 丢弃之前的 BFCache 条目
- CDP 缓存清除：`Network.clearBrowserCache` 可在帖子间调用
- 合并 CDP 调用：将 `ensureExpectedLocation` + scroll metrics 合并为单次 evaluateInPage
- `Page.enable`/`Runtime.enable` 不建议关闭（后续 evaluateInPage 需要 Runtime domain）
