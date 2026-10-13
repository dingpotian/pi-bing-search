# pi-bing-search

[![license](https://img.shields.io/badge/license-MIT-4A90D9.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-43853D.svg)](https://nodejs.org)

[中文](./README.md)

**Real-Chromium Bing web search for [Pi](https://github.com/earendil-works/pi)** — a `bing_search` tool that returns real, fresh, ranked results where plain HTTP scrapers fail.

Bing serves degraded or garbage results to cold automated requests (a bare `GET` gets an `rdr=1` bounce or a page full of unrelated cached links). This extension instead drives a real Chromium through the genuine human flow — seed cookies on `cn.bing.com`, type the query into the search box, press Enter, and scrape the ranked result list.

## Why a real browser?

| Approach | What you get |
|---|---|
| Plain HTTP / RSS scrape | `rdr=1` redirect bounce, or unrelated cached results |
| Headless API / curl | Same — Bing fingerprints the request and degrades it |
| **This extension (real Chromium)** | Genuine ranked results, paginated like a human session |

The extension navigates with a fixed Chrome desktop user agent, disables the `navigator.webdriver` flag, and reuses a single browser context so cookies (`MUID` / `SRCHD` / …) accumulate across searches — exactly what keeps Bing from treating the session as a bot.

## Install

```bash
# from npm (recommended)
pi install npm:pi-bing-search

# or from a git checkout
pi install git:github.com/dingpotian/pi-bing-search

# or from a local path (registered by reference, not copied)
pi install ./pi-bing-search
```

Then run `/reload` in Pi (or restart) so the extension registers.

### Browser binary

The extension depends on `playwright` (any installed version). The browser binary is **not** downloaded by `npm install` — each user must fetch it once:

```bash
npx playwright install chromium
```

Playwright downloads the Chromium that matches the installed version (cached at `~/AppData/Local/ms-playwright/` on Windows, `~/.cache/ms-playwright/` on Linux/macOS); if a matching version is already cached, this step completes instantly with no network access.

## Tools

### `bing_search`

Search the web via Bing and return a ranked list of results (title, URL, description — metadata only). Results are paginated automatically up to Bing's 50-page ceiling. Use a fetch/read tool on the returned URLs to get full page content.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | ✅ | — | Search query |
| `limit` | integer | — | `5` | How many results to collect (min `1`, max `500`) |

### Output

The model-facing `content` is a JSON document of the shape below, truncated per Pi's conventions (≈50 KB / 2000 lines). `structuredContent` carries the same data machine-readably for programmatic callers.

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

## Configuration

| Env var | Effect |
|---|---|
| `PI_BING_HEADED=1` | Launch Chromium headed instead of headless (debugging) |

Everything else is a fixed, conservative code constant in `index.ts`:

| Behavior | Value |
|---|---|
| Idle browser close | 3 minutes (lazy relaunch on next search) |
| Pagination ceiling | 50 pages (~500 hits) |
| Per-call wall-clock cap | 120 s |
| Navigation / result timeouts | 45 s / 15 s |

## Behavior notes

- **Single shared browser.** One browser + context is reused across searches; all operations are serialized by a mutex, so a single browser is never driven concurrently.
- **Cookie accumulation.** Cookies persist in the reused context, keeping the session "warm" for Bing.
- **Idle shutdown.** Three minutes after the last search, the browser closes to free memory; the next search lazily relaunches it.
- **Abort & timeout.** An aborted or timed-out call closes the browser immediately (which unblocks any hung Playwright call) rather than leaving it wedged.
- **Read-only + networked.** The tool is annotated `readOnlyHint` / `openWorldHint` so Pi knows it neither mutates state nor is deterministic.

## Requirements

- **Node >= 20** (playwright's minimum).
- **Chromium** in the Playwright cache (`npx playwright install chromium` fetches the matching version).

## Uninstall

```bash
pi remove pi-bing-search
```

## License

[MIT](./LICENSE) — Copyright © 2026 dingpotian.
