# brainstorm: 无限刷帖模式 - 面板设置帖子数量

## Goal

用户希望在弹窗面板中增加一个帖子数量设置控件，默认为无限刷帖（不自动停止），用户可选择设置一个固定目标数量，到达后自动停止。

## What I already know

- 当前唯一的用户设置是速度滑块（5档）
- 进度显示当前是 `current / total` 格式，其中 total 是当前页面的帖子数（Discourse /latest 页面约 28 个帖子）
- 代码中 **没有** 帖子数量上限，理论上会一直翻页刷下去直到没有更多页面
- 用户看到 "28 个帖子就停了" 可能是因为：进度条显示 28/28 后翻页时 UI 没及时更新，或者翻页逻辑有实际问题
- 核心浏览循环在 `background.js` 的 `browseCurrentListPage()` (line 375)
- 进度通过 `chrome.storage.local` 的 `browseData` 传递到 popup

## Assumptions (temporary)

- 用户看到的 "28 帖停止" 是因为 Discourse 页面大小约 28，翻页时可能有问题或 UI 反馈让人以为停了
- 默认应该是无限模式（不设上限，一直刷到没有更多帖子或手动停止）
- 设置值需要持久化存储（下次打开弹窗还能看到）

## Decision (ADR-lite)

**Context**: 帖子数量设置的 UI 交互方式
**Decision**: 数字输入框，留空或 0 表示无限刷帖
**Consequences**: 最灵活，用户可输入任意数字；需要做输入验证（正整数）

## Open Questions

- （已解决）

## Requirements (evolving)

- popup 中新增帖子数量设置控件（数字输入框，placeholder 为"无限"）
- 默认值为空/0 表示无限模式
- 用户可输入任意正整数作为目标数量
- background.js 中新增总帖子计数器（跨页面累加）
- 到达目标数量时自动停止，状态显示为 "complete"
- 进度显示格式：有限模式 `15 / 50`，无限模式 `15 / ∞`
- 进度条在无限模式下隐藏（无限模式无终点，进度条无意义）
- 设置值持久化到 `chrome.storage.local`（key: `postLimit`）
- 输入验证：只允许正整数，非法输入自动修正为 0（无限）
- 有限模式下帖子计数器跨页面累加（session 中新增 `totalBrowsed` 字段）
- 帖子数量设置在浏览过程中可修改（正在运行时修改后，下一次检查时生效）

## Acceptance Criteria (evolving)

- [ ] 默认无限模式：不停止，一直刷到没有更多帖子
- [ ] 用户可设置目标帖子数量（如 50、100）
- [ ] 到达目标数量后自动停止
- [ ] 进度显示正确反映全局进度
- [ ] 设置值在 popup 关闭后保留

## Definition of Done

- 手动测试：无限模式刷过 28 个帖子后继续翻页
- 手动测试：设置目标数量 30，刷到 30 个自动停止
- 进度显示在翻页时正确更新
- Lint / 无报错
- 设置值持久化验证

## Out of Scope (explicit)

- 帖子过滤/筛选功能
- 定时/计划任务功能
- 浏览历史记录功能

## Technical Notes

- 核心修改文件：`background.js`、`popup.html`、`popup.js`、`popup.css`
- `browseData` 当前结构：`{ total, current, title, error }`，需扩展支持全局计数
- session 对象（line 20）需要新增全局帖子计数字段
- 进度 UI 的 `showProgress()` (popup.js line 32) 需要适配无限模式显示
