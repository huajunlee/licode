// 探测：哪些搜索引擎端点能在纯 HTTP（无浏览器）下拿到真实结果
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const targets = [
  ["DDG lite", "https://lite.duckduckgo.com/lite/?q=licode+agent"],
  ["DDG html", "https://html.duckduckgo.com/html/?q=licode+agent"],
  ["Mojeek", "https://www.mojeek.com/search?q=licode+agent"],
  ["Marginalia", "https://search.marginalia.nu/search?query=licode+agent"],
  ["Bing", "https://www.bing.com/search?q=licode+agent"],
  ["Searx.be json", "https://searx.be/search?q=licode+agent&format=json"],
  ["Wikipedia API", "https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=LICode&format=json"],
  ["Brave HTML", "https://search.brave.com/search?q=licode+agent"],
  ["Ecosia", "https://www.ecosia.org/search?q=licode+agent"],
  ["Startpage", "https://www.startpage.com/sp/search?query=licode+agent"],
];

for (const [name, url] of targets) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      signal: ctl.signal,
      redirect: "follow",
    });
    const body = await res.text();
    const blocked = /anomaly|challenge|captcha|unusual traffic|are you a robot/i.test(body);
    // 粗判：正文里出现搜索词相关的链接条数
    const links = (body.match(/https?:\/\/[^"'\s<>]+/g) || []).length;
    console.log(
      `${name.padEnd(15)} ${res.status} len=${String(body.length).padStart(7)} links=${String(links).padStart(5)} ${blocked ? "🚫 反爬挑战" : "—"}`
    );
  } catch (e) {
    console.log(`${name.padEnd(15)} 失败: ${e.name === "AbortError" ? "超时" : e.message}`);
  } finally {
    clearTimeout(timer);
  }
}
