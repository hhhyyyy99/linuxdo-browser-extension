# LinuxDo Auto Browse

自动浏览 LinuxDo 论坛帖子的 Chrome 扩展，模拟真人阅读行为。

> 需要 Chrome 118 或更高版本。扩展会使用 Chrome Debugger Protocol 控制一个分组内的 LinuxDo 标签页，从而避免要求用户一直保持该标签激活。

## 安装

1. 下载或克隆本项目
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择项目目录

## 使用

1. 打开 [linux.do](https://linux.do) 并登录
2. 点击扩展图标，打开控制面板
3. 调整浏览速度（默认慢速）
4. 点击「开始浏览」

如果当前没有 LinuxDo 标签页，扩展会自动创建 `https://linux.do/latest` 标签页，并放入「LinuxDo 刷帖」分组。

## 功能

- 自动按顺序浏览 `/latest` 页面的帖子
- 模拟真人阅读：缓慢滚动 + 随机停顿
- 帖子内容懒加载触发
- 浏览完当前页自动翻页
- 单个分组标签页运行：优先复用已有 LinuxDo 标签，没有则自动新建
- 标签无需保持激活，用户可以继续使用其他浏览器标签
- 加载失败自动跳过继续下一个
- 点击「停止」随时中止

## 速度设置

| 级别 | 滚动速度 | 适用场景 |
|------|---------|---------|
| 极慢 | 0.2-0.8 px/80ms | 最自然 |
| 慢速 | 0.5-2.5 px/60ms | 默认 |
| 中速 | 1.5-5.0 px/40ms | 较快 |
| 快速 | 4-10 px/30ms | 快速浏览 |
| 极快 | 24-56 px/70ms | 最快，降低高频滚动压力 |

## 技术说明

- Chrome Extension Manifest V3
- Background Service Worker 管理状态、标签组和 CDP 自动化
- Chrome Debugger Protocol 负责导航、页面检测和滚动输入
- Popup 控制界面
