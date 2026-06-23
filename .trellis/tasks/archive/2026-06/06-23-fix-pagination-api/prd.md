# fix: 修复翻页 - 改用 Discourse JSON API 获取帖子列表

## Goal

修复刷帖只能刷一页 ~30 个就停止的问题。根因：Discourse 使用无限滚动，DOM 中没有传统分页链接。

## Requirements

- 用 Discourse JSON API (`/latest.json?page=N`) 替代 DOM 抓取获取帖子列表
- API 返回每页 30 个帖子，通过 `more_topics_url` 判断下一页
- 保留 DOM 浏览单个帖子（滚动、阅读）的逻辑不变
- 无限模式和目标数量模式均正常工作

## Technical Approach

- `collectListInfo()` 改为调用 `fetchTopicListFromApi(page)` 
- session 新增 `currentPage` 字段跟踪页码
- 每次翻页 `currentPage++`，重新调 API
- API 返回 topics 数组 + more_topics_url（有则继续，无则 complete）

## Files to modify

- `background.js`: 新增 API 获取逻辑，修改 `browseCurrentListPage()` 翻页流程
