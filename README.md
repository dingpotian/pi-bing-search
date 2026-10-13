# pi-bing-search

Pi 扩展：用真实 Chromium（Playwright）做 Bing 网页搜索。

Bing 对冷会话的自动化请求（纯 HTTP / RSS 抓取）会返回降级/垃圾结果，因此本插件驱动一个真实
Chromium 走「真人流程」：先访问 `cn.bing.com` 种 cookie → 搜索框逐字输入 → 回车 → 等待
`#b_results li.b_algo` → 提取 → 翻页。

## 工具

- **`bing_search`**
  - 参数：`query`（必填）、`limit`（可选，默认 5，最大 500）
  - 返回：`{ backend, query, results: [{ title, url, description, position }] }`
  - 只读 + 联网（`readOnlyHint` / `openWorldHint`）

## 安装

```bash
cd pi-bing-search
npm install
npx playwright install chromium
```

> 注意：`playwright` 依赖已固定为 `1.62.1`（对应 chromium revision 1234 / Chrome 151）。
> 浏览器二进制**不会**随 `npm install` 自动下载，`npx playwright install chromium` 这一步需要
> 每位用户在自己的机器上跑一次（若系统已缓存 chromium 1234 则秒过，无需联网）。

然后安装到个人全局扩展目录：

```bash
# 方式一：直接复制（个人全局）
mkdir -p ~/.pi/agent/extensions
cp -r . ~/.pi/agent/extensions/pi-bing-search

# 方式二：pi install（本地路径）
pi install ./pi-bing-search
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `PI_BING_HEADED=1` | 强制有头模式（调试用），默认无头（新版完整 Chromium） |

（空闲关闭时间 3 分钟、翻页上限 50 页、硬超时 120s 均为代码常量，见 `index.ts`。）

## 实现要点

- 单例浏览器 + 复用 context（cookie 累积），全局互斥串行化
- 空闲 3 分钟自动关闭浏览器，下次搜索懒启动重建
- 120s 单次调用硬超时、50 页翻页封顶（≈500 条）
- 输出按 Pi 规范截断（50KB / 2000 行），并返回 `structuredContent`
