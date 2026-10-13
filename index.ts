/**
 * pi-bing-search — Pi extension: Bing web search via a real Chromium browser.
 *
 * Faithful port of the "human flow" collector (reference: artex-192-work Bing
 * collector). Bing returns garbage/degraded results for cold automated requests
 * (plain HTTP or RSS scrape), so we drive a real Chromium through the genuine
 * flow — visit cn.bing.com to seed cookies → type the query into the search box
 * → press Enter → wait for #b_results li.b_algo → extract → paginate.
 *
 * Browser lifecycle: one reused browser + context (cookies accumulate), all
 * operations serialized by a mutex (a single browser is never driven
 * concurrently). After each search the idle timer resets; after 3 minutes of
 * no use the browser closes to free memory and lazily relaunches on the next
 * search.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────────
const BING_HOME = "https://cn.bing.com/";
const BING_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IDLE_CLOSE_MS = 3 * 60 * 1000; // close browser after 3 min idle
const MAX_PAGES = 50; // Bing paging ceiling
const MAX_LIMIT = 500; // loose safety valve (~50 pages × 10 hits)
const WALL_CLOCK_MS = 120 * 1000; // per-call wall-clock cap
const NAV_TIMEOUT_MS = 45000;
const RESULT_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Browser singleton state ──────────────────────────────────────────────────
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let lastUsed = 0;
let idleTimer: NodeJS.Timeout | null = null;

// Serialize all browser operations (single browser instance).
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function closeBrowserNow(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const b = browser;
  const c = context;
  browser = null;
  context = null;
  // Bound the close with a race: a stuck Close must never wedge future searches.
  if (c) await Promise.race([c.close().catch(() => {}), sleep(2000)]);
  if (b) await Promise.race([b.close().catch(() => {}), sleep(2000)]);
}

function scheduleIdleClose(): void {
  lastUsed = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void serialize(async () => {
      // Only close if still idle (a newer search would have refreshed lastUsed).
      if (Date.now() - lastUsed >= IDLE_CLOSE_MS) {
        await closeBrowserNow();
      }
    });
  }, IDLE_CLOSE_MS);
}

async function ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  if (browser && context && browser.isConnected()) {
    return { browser, context };
  }
  // Dead reference — clean up before relaunching.
  await closeBrowserNow();

  const b = await chromium.launch({
    // Full Chromium new-headless (Playwright >= 1.49); the old headless shell
    // does not render Bing's results region. PI_BING_HEADED=1 forces headed for
    // debugging.
    headless: process.env.PI_BING_HEADED !== "1",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });
  try {
    const ctx = await b.newContext({
      userAgent: BING_UA,
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
    });
    await ctx.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => false });",
    );

    // First visit seeds cookies (MUID/SRCHD/cvid…). Cannot be skipped — a cold
    // context jumps straight to a degraded results page or an rdr=1 bounce.
    const page = await ctx.newPage();
    try {
      await page.goto(BING_HOME, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(5000);
    } finally {
      await page.close().catch(() => {});
    }

    browser = b;
    context = ctx;
    return { browser: b, context: ctx };
  } catch (err) {
    await b.close().catch(() => {});
    throw err;
  }
}

// ── Extraction ───────────────────────────────────────────────────────────────
interface BingHit {
  title: string;
  url: string;
  description: string;
}

async function extractPage(page: Page): Promise<BingHit[]> {
  const raw: Array<{ title: string; url: string; desc: string } | null> = await page.$$eval(
    "#b_results li.b_algo",
    (els: any[]) =>
      els
        .map((li: any) => {
          const a = li.querySelector("h2 a");
          if (!a) return null;
          const p = li.querySelector("p, .b_caption p, .b_lineclamp");
          // innerText depends on layout/visibility; when Bing marks results
          // visibility:hidden, innerText is empty — textContent is the fallback.
          const title = String((a.innerText || a.textContent) ?? "").trim();
          const desc = p ? String((p.innerText || p.textContent) ?? "").trim() : "";
          return { title, url: String(a.href ?? ""), desc };
        })
        .filter((x: any) => x !== null),
  );
  const out: BingHit[] = [];
  for (const it of raw) {
    if (!it) continue;
    const url = it.url.trim();
    if (!url) continue;
    out.push({ title: it.title.trim(), url, description: it.desc.trim() });
  }
  return out;
}

// ── Search flow ──────────────────────────────────────────────────────────────
// Note: `type` (not `interface`) so the object literal type gets an implicit
// index signature and satisfies `JsonValue` in `structuredContent`.
type SearchResult = {
  title: string;
  url: string;
  description: string;
  position: number;
};

async function bingSearch(query: string, limit: number): Promise<SearchResult[]> {
  const { context: ctx } = await ensureBrowser();

  const page = await ctx.newPage();
  try {
    // Human flow: return to home first (cookies already warm after seeding).
    await page.goto(BING_HOME, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1500);

    const box = page.locator("#sb_form_q");
    await box.click({ timeout: RESULT_TIMEOUT_MS });
    await box.fill("");
    await box.type(query, { delay: 90 });
    await page.keyboard.press("Enter");

    await page.waitForSelector("#b_results li.b_algo", {
      timeout: RESULT_TIMEOUT_MS,
      state: "attached",
    });
    await page.waitForTimeout(1000);

    const out: SearchResult[] = [];
    const seen = new Set<string>();

    for (let pg = 1; pg <= MAX_PAGES && out.length < limit; pg++) {
      const hits = await extractPage(page);
      if (hits.length === 0) break; // throttled or end of results
      for (const h of hits) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        out.push({
          title: h.title,
          url: h.url,
          description: h.description,
          position: out.length + 1,
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit || pg >= MAX_PAGES) break;

      const nxt = page.locator("a.sb_pagN").last();
      if ((await nxt.count()) === 0) break;
      await nxt.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await nxt.click({ timeout: RESULT_TIMEOUT_MS }).catch(() => {
        return;
      });
      await page
        .waitForSelector("#b_results li.b_algo", {
          timeout: RESULT_TIMEOUT_MS,
          state: "attached",
        })
        .catch(() => {});
      await page.waitForTimeout(1000);
    }

    if (out.length === 0) {
      throw new Error(`Bing returned no results for "${query}"`);
    }
    return out;
  } finally {
    await page.close().catch(() => {});
  }
}

function withWallClock<T>(fn: () => Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ── Tool definition ──────────────────────────────────────────────────────────
const BingSearchParams = Type.Object({
  query: Type.String({ description: "The search query." }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: "How many results to collect (default 5).",
    }),
  ),
});

const SearchResultSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  description: Type.String(),
  position: Type.Integer(),
});

const BingSearchOutputSchema = Type.Object({
  backend: Type.String(),
  query: Type.String(),
  results: Type.Array(SearchResultSchema),
});

interface BingSearchDetails {
  backend: string;
  query: string;
  limit: number;
  resultCount: number;
  elapsedMs: number;
  truncated?: boolean;
}

const bingSearchTool = defineTool({
  name: "bing_search",
  label: "Bing Search",
  description:
    "Search the web using Bing (a real headless Chromium browser, because Bing rejects plain HTTP automation) and return a ranked list of results — title, URL, description (metadata only). Choose how many results to collect via `limit` (default 5, max 500); results are paginated automatically up to Bing's 50-page ceiling. Use a fetch/read tool to retrieve the full content of a specific URL. This makes an external network request and can take a few seconds.",
  promptSnippet: "Bing web search (title, URL, description).",
  promptGuidelines: [
    "Use bing_search to discover current web pages; then use a fetch/read tool on the returned URLs to get full page content.",
  ],
  parameters: BingSearchParams,
  outputSchema: BingSearchOutputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const query = String(params.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: "Error: query must not be empty." }],
        details: { backend: "bing", query: "", limit: 0, resultCount: 0, elapsedMs: 0 } as BingSearchDetails,
        isError: true,
      };
    }
    const limit = params.limit ?? 5;
    const started = Date.now();

    // Abort handling: closing the browser unblocks any hung Playwright call.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void closeBrowserNow();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const results = await serialize(() =>
        withWallClock(
          () => bingSearch(query, limit),
          WALL_CLOCK_MS,
          () => void closeBrowserNow(),
        ),
      );
      const elapsedMs = Date.now() - started;

      const json = JSON.stringify({ backend: "bing", query, results }, null, 2);
      const truncation = truncateHead(json, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      const details: BingSearchDetails = {
        backend: "bing",
        query,
        limit,
        resultCount: results.length,
        elapsedMs,
        truncated: truncation.truncated,
      };
      return {
        content: [{ type: "text", text }],
        details,
        structuredContent: { backend: "bing", query, results },
      };
    } catch (err) {
      if (aborted) {
        return {
          content: [{ type: "text", text: "Bing search aborted." }],
          details: { backend: "bing", query, limit, resultCount: 0, elapsedMs: Date.now() - started } as BingSearchDetails,
          isError: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error searching Bing: ${msg}` }],
        details: { backend: "bing", query, limit, resultCount: 0, elapsedMs: Date.now() - started } as BingSearchDetails,
        isError: true,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      scheduleIdleClose();
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(bingSearchTool);
}
