# pi-bing-search

[![license](https://img.shields.io/badge/license-MIT-4A90D9.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-43853D.svg)](https://nodejs.org)

[English](./README.en.md)

为 [Pi](https://github.com/earendil-works/pi) 提供 **真实 Chromium 驱动的 Bing 网页搜索**——一个 `bing_search` 工具，在纯 HTTP 抓取失效的场景下返回真实、新鲜、排好序的搜索结果。

Bing 对冷会话的自动化请求会返回降级/垃圾结果：裸 `GET` 会触发 `rdr=1` 弹回，或整页替换成无关的缓存结果。本扩展改为驱动一个真实 Chromium 走「真人流程」：先在 `cn.bing.com` 种 cookie → 搜索框逐字输入 → 回车 → 抓取排序结果列表。

## 为什么用真实浏览器？

| 方案 | 结果 |
|---|---|
| 纯 HTTP / RSS 抓取 | `rdr=1` 弹回，或无关缓存结果 |
| Headless API / curl | 同样——Bing 会指纹识别请求并降级 |
| **本扩展（真实 Chromium）** | 真实排序结果，像真人会话一样翻页 |

扩展使用固定 Chrome 桌面 UA 导航，禁用 `navigator.webdriver` 标志，并复用单一浏览器 context 让 cookie（`MUID` / `SRCHD` / …）跨搜索累积——正是这些让 Bing 不把会话当机器人。

## 安装

```bash
# 从 npm 安装（推荐）
pi install npm:pi-bing-search

# 从 git 仓库安装
pi install git:github.com/dingpotian/pi-bing-search

# 或从本地路径安装（按路径引用注册，不复制）
pi install ./pi-bing-search
```

然后在 Pi 里运行 `/reload`（或重启）让扩展注册。

### 浏览器二进制

扩展固定 `playwright@1.62.1`（Chromium revision 1234 / Chrome 151）。浏览器二进制**不会**随 `npm install` 下载——每位用户需要单独跑一次：

```bash
npx playwright install chromium
```

如果你的机器已经在 Playwright 缓存里有 `chromium-1234`（Windows 在 `~/AppData/Local/ms-playwright/`，Linux/macOS 在 `~/.cache/ms-playwright/`），这一步无需联网、秒过。

## 工具

### `bing_search`

用 Bing 搜索网页，返回排序结果列表（标题、URL、描述——仅元数据）。结果自动翻页，最多到 Bing 的 50 页上限。用 fetch/read 工具访问返回的 URL 获取完整页面内容。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `query` | string | ✅ | — | 搜索关键词 |
| `limit` | integer | — | `5` | 收集多少条结果（最小 `1`，最大 `500`） |

### 输出

面向模型的 `content` 是下面结构的 JSON 文档，按 Pi 规范截断（约 50 KB / 2000 行）。`structuredContent` 以机器可读形式携带同样数据，供程序化调用方使用。

```json
{
  "backend": "bing",
  "query": "OpenAI latest release",
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "description": "…",
      "position": 1
    }
  ]
}
```

## 配置

| 环境变量 | 作用 |
|---|---|
| `PI_BING_HEADED=1` | 以有头模式启动 Chromium（调试用），默认无头 |

其余均为 `index.ts` 里固定的保守常量：

| 行为 | 值 |
|---|---|
| 空闲关闭浏览器 | 3 分钟（下次搜索懒启动） |
| 翻页上限 | 50 页（约 500 条） |
| 单次调用墙钟上限 | 120 s |
| 导航 / 结果超时 | 45 s / 15 s |

## 行为说明

- **单一共享浏览器**：跨搜索复用同一个浏览器 + context；所有操作由互斥锁串行化，单一浏览器不会被并发驱动。
- **Cookie 累积**：cookie 在复用 context 中持续存在，让会话对 Bing 保持「温热」。
- **空闲关闭**：最后一次搜索 3 分钟后关闭浏览器释放内存；下次搜索懒启动重建。
- **中止与超时**：被中止或超时的调用会立即关闭浏览器（从而解除任何挂起的 Playwright 调用），而不是让它卡住。
- **只读 + 联网**：工具标注 `readOnlyHint` / `openWorldHint`，Pi 据此知道它既不改变状态也非确定性。

## 要求

- **Node >= 20**（playwright 1.62.1 的最低要求）。
- **Chromium** 在 Playwright 缓存中（`npx playwright install chromium`），或已缓存 `chromium-1234`。

## 卸载

```bash
pi remove pi-bing-search
```

## License

[MIT](./LICENSE) — Copyright © 2026 dingpotian。
