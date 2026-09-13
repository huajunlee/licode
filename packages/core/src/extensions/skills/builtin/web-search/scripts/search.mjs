#!/usr/bin/env node
/**
 * 联网搜索：走 DuckDuckGo 的 lite 端点（纯 HTTP，无需 API key）。
 *
 * 用法: node search.mjs "<查询词>" [结果条数]
 *
 * 为什么不用 html.duckduckgo.com：那个端点对非浏览器请求返回 202 + 反爬挑战页，
 * 实测拿不到结果；lite 端点在同样的纯 HTTP 条件下能稳定返回结果列表。
 * 已实测的不可用端点：html.duckduckgo.com（挑战页）、bing.com（挑战页）、
 * search.brave.com（429）、ecosia.org（403）、searx.be 的 json API（挑战页）。
 *
 * 退出码：0 = 查到（含 0 条结果）；1 = 请求失败或被反爬拦截。
 */

const ENDPOINT = "https://lite.duckduckgo.com/lite/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;
const DEFAULT_MAX = 6;

const [query, maxArg] = process.argv.slice(2);
if (!query) {
  console.error('用法: node search.mjs "<查询词>" [结果条数]');
  process.exit(2);
}
const max = Math.min(Math.max(Number.parseInt(maxArg ?? "", 10) || DEFAULT_MAX, 1), 20);

/** 去掉标签、还原实体，压平空白。 */
function plain(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG 把结果 URL 包在 /l/?uddg=<编码后的真实地址> 里，要解出来。 */
function realUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* 解码失败就退回原样 */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

function parse(body) {
  const results = [];

  // 先用宽松的标签正则取出每个 <a ...>，再自己判断 class——
  // 属性顺序不固定，写死 "href 在 class 前" 会漏。
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1];
    if (!/class=['"]result-link['"]/.test(attrs)) continue;
    const href = attrs.match(/href="([^"]*)"/)?.[1] ?? "";
    const title = plain(m[2]);
    if (title) results.push({ title, url: realUrl(href), snippet: "" });
  }

  // 摘要在独立的一行 <td class='result-snippet'>，按出现顺序与上面一一对应。
  const snippets = [...body.matchAll(/<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)].map(
    (m) => plain(m[1])
  );
  results.forEach((r, i) => {
    if (snippets[i]) r.snippet = snippets[i];
  });

  // 同 URL 去重（DDG 偶尔重复），保序
  const seen = new Set();
  return results.filter((r) => !seen.has(r.url) && seen.add(r.url));
}

const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

let res;
let body;
try {
  res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: ctl.signal,
    redirect: "follow",
  });
  body = await res.text();
} catch (err) {
  console.error(
    `搜索失败：${err.name === "AbortError" ? `请求超过 ${TIMEOUT_MS / 1000}s 未返回` : err.message}`
  );
  process.exit(1);
} finally {
  clearTimeout(timer);
}

// 反爬挑战页：状态码不一定是错误码，得看正文特征
if (/anomaly|challenge|captcha|unusual traffic/i.test(body)) {
  console.error("搜索失败：被 DuckDuckGo 反爬拦截（短时间内请求过多会出现），稍后重试或换个查询词。");
  process.exit(1);
}
if (!res.ok) {
  console.error(`搜索失败：HTTP ${res.status}`);
  process.exit(1);
}

const results = parse(body);
if (results.length === 0) {
  console.log(`没有找到「${query}」的结果。换个更宽泛的关键词，或改用英文再试。`);
  process.exit(0);
}

const shown = results.slice(0, max);
console.log(`「${query}」共 ${results.length} 条，显示前 ${shown.length} 条：\n`);
shown.forEach((r, i) => {
  console.log(`${i + 1}. ${r.title}`);
  console.log(`   ${r.url}`);
  if (r.snippet) console.log(`   ${r.snippet}`);
  console.log("");
});
