---
name: web-search
description: 联网搜索公开信息时使用。当本地记忆、日记和人物档案里都没有所需信息，而回答又依赖外部事实时用它补充——查资料、核实说法、了解某个产品/技术/机构/政策的现状、找官方文档或最新消息。当用户说"帮我查一下""搜一下""这个是什么""现在怎么样了"，或你自己判断本地数据不足以支撑回答时使用，即使他没明说"上网搜"。个人经历与偏好、纯推理/写作/编码任务、能直接从本地文件或代码回答的问题不要用。
---

# 联网搜索

用户的记忆、日记和人物档案是回答**关于他本人**的问题的第一来源，先查那些。
但涉及外部世界的事实——某个版本发布了没有、某项政策怎么规定、某个库的 API 长什么样——
本地没有，这时联网搜。

## 怎么搜

搜索有两个入口，**优先用 ego-browser，不行再降级**。原因：`search.mjs` 走 DuckDuckGo，
短时间多次请求容易被反爬拦截（见文末"一个实际限制"）；ego-browser 是真实浏览器，
抗反爬、能读 JS 渲染的页面，更适合拿原始内容。

### 首选：ego-browser

先确认本机有它：

```bash
command -v ego-browser && ls "<ego 技能目录>/SKILL.md"
```

ego-browser 的用法以它自己的技能文档为准（通常位于 `~/.agents/skills/ego-browser/SKILL.md`），
**先读那份文档再操作**，不要凭对 Playwright 的印象去猜它的 API。基本用法是跑一段 Node 脚本：

```bash
ego-browser nodejs < script.js
```

搜索走 Bing（比 DuckDuckGo 稳），用 `goto()` 打开搜索页再读结果：

```js
const task = await taskSpace("search keywords");
const page = task.page("p1");
await page.goto("https://www.bing.com/search?q=" + encodeURIComponent("查询词"));
await page.waitForLoadState();
console.log(await page.snapshot({ scope: "full_page" }));
```

两个坑：① 前台执行容易超时（浏览器服务拉起 + 等待），把脚本写进文件后台跑
（`ego-browser nodejs < script.js > out.log 2>&1 &`）再读日志更稳；② 用完记得 `task.finish()`。

**本机没有 ego-browser，或它失败/超时**，就降到下面的 `search.mjs`。

### 降级：search.mjs（DuckDuckGo）

技能目录（见你的技能书目层）下的 `scripts/search.mjs`：

```bash
node "<技能目录>/scripts/search.mjs" "查询词" [结果条数]
```

**用关键词，不要写整句。** 搜索引擎匹配的是词，不是问句：

- ✅ `DeepSeek V4 定价`
- ❌ `DeepSeek V4 现在多少钱一个月`

中文搜不到就换英文再搜一次——技术类内容英文结果往往更全、更新。

输出长这样，每条含标题、URL、摘要：

```
「DeepSeek V4 定价」共 8 条，显示前 4 条：

1. DeepSeek 官方定价页
   https://api-docs.deepseek.com/quick_start/pricing
   DeepSeek-V4 输入 ¥0.5 / 百万 tokens …
```

## 怎么用搜到的东西

**摘要是线索，不是结论。** 它由搜索引擎从页面里截出来，可能过时、可能断章取义。
要拿它当依据时，用 Bash 把那个 URL 抓下来（`curl -sL "<url>"`）看原文，
尤其是数字、日期、版本号这类一旦错了就会误导用户的细节。

**抓不到就别硬抓。** 很多文档站是 JS 渲染的，`curl` 拿回来只有骨架、正文是空的。
试**一两次**换个抓法（`--compressed`、看 `__NEXT_DATA__` 之类的内联 JSON）就够了；
还是没有就停下来，直接把搜索摘要作为依据并注明来源与日期，别连着一遍遍换 sed/grep
——那烧掉的调用比省下的那点不确定性值钱得多。

**说清楚是"搜到的"还是"确认的"。** 只有摘要就直说"搜索结果里提到…"并给出链接；
读过原文再说"官方文档写明…"。这两句话的可信度不一样，别混着用。

**搜不到不等于不存在。** 脚本报"没有找到结果"只说明这个查询词没命中，
换个词、换英文、放宽范围再试；仍然没有就如实告诉用户你没查到，
不要拿模型自身的记忆去填——那部分可能已经过时，而你刚才正是在为它是否可靠而联网。

## 什么时候别用

- 问题关于用户本人（经历、偏好、人际、过往决定）→ 查记忆/日记/人物档案，联网搜不到这些
- 纯推理、写作、编码、翻译 → 直接做
- 答案是常识或不随时间变（数学、算法原理）→ 直接答
- 你已经能确定答案 → 别为了"稳妥"搜一下，白花时间和 token

## 一个实际限制

这是 `search.mjs`（降级入口）的限制：DuckDuckGo 会对短时间内的高频请求返回反爬拦截页，
脚本检测到会明确报错并退出 1。**不要连着一口气搜五六次**；一次搜不到就换查询词，
而不是原样重试。被拦截时等一会儿再试——**或者改用首选入口 ego-browser，它不受这个限制**。
