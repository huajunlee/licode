# decide 技能 — 测试与效果总结

- 日期：2026-09-13
- 分支：`feat/decide-skill`（未合未推）
- 模型：`deepseek-v4-flash` @ `https://api.deepseek.com/anthropic`
- 相关记录：`decide-skill-test-run.md`（修复前对照）、`verify-e2e-run.md`（修复后验收）

**一句话结论**：修了 7 个问题，测试全绿、端到端 10/10；但**没有 baseline 对照，所以"效果好不好"这件事目前无法归因给 decide 技能**——这是最大的一块空白。

---

## 1. 总览

| 项目 | 结果 |
|---|---|
| 单元 / 集成测试 | **103 文件 · 779 条 · 全部通过** |
| 本会话新增测试 | 21 条（套件 758 → 779） |
| 端到端验收 | **10/10 检查点通过**（两个场景） |
| 本会话提交 | 7 个 |
| 未能定位的失败 | 0（抖动已全部归因） |

---

## 2. 本会话修的 7 个问题

| 提交 | 问题 | 根因 |
|---|---|---|
| `7b95df8` | 日记多词查询全返回空 | `store.ts` 把整个 query 当一个子串匹配，模型天然写多词 → 必然失配 |
| `7b95df8` | Bash 失败时丢失 stdout | `bash.ts` 失败分支只返回 `e.message`，"跑一串诊断命令、其中一条失败"的输出被整个丢弃 |
| `0b7c22e` | thinking 模式端点第二轮必 400 | **两处**：① thinking 文本与 signature 都没留下；② 一次响应被拆成两条 assistant 消息（实测拆分必被拒） |
| `a5b12aa` | 模型拿错路径找用户数据 | 系统提示里没有任何地方写明 cwd，而上下文里唯一的绝对路径来自技能书目层 → 被当成项目根 |
| `8a2a3d2` | 召回失败与"确实没有记忆"不可分 | `memory_recall` catch 吞掉一切，降级成同一句话 |
| `8c3b980` | 多段概述撑破 YAML frontmatter | 截断到 100 字时没压平换行 |
| `f670ac0` | 钩子提前退出 → 未捕获 EPIPE → CLI 崩溃 | `proc.stdin` 没挂 error 处理器；`proc.on("error")` 捕不到流上的错误 |

其中 `0b7c22e` 的第二个根因是靠**打原始 `/v1/messages` 做对照实验**才定位的：

```
❌ 拆分：assistant(文本) + assistant(thinking+tool_use)   ← LICode 现状，精确复现
✅ 合并：assistant(thinking + 文本 + tool_use)
✅ 合并：assistant(thinking + tool_use)
```

---

## 3. 单元 / 集成测试

```
103 个文件 · 779 条测试 · 全部通过
```

### 本会话新增 21 条

| 文件 | 新增 | 覆盖内容 |
|---|---|---|
| `llm/thinking.test.ts` | 11（新文件） | thinking 块回传形状、同轮文本合并顺序、`takeTrailingAssistantText` 的回收与不动历史 |
| `tools/builtin/bash.test.ts` | 5（新文件） | 失败保留 stdout、退出码、成功带 stderr、无装饰兼容、空输出 |
| `diary/store.test.ts` | 3 | 多词 OR 命中、按命中词数排序、空白查询不返回全部 |
| `people/serialize.test.ts` | 1 | 多段概述不撑破 frontmatter |
| `extensions/hooks/manager.test.ts` | 1 | 钩子提前退出不产生未捕获异常 |

另有 2 条**改写**（非新增）：`memory-recall.test.ts` 的降级断言、`decide-reflect.test.ts` 的描述断言。

### 一条教训：假通过的测试

第一版 `bash.test.ts` 断言 `toContain("/tmp")`，而失败时 Node 会把**整条命令回显进错误信息**，命令里正好有 `/tmp`——测试因为错误的原因通过了。已全部改成"命令里没有、只有输出才会产生"的标记（`$((6*7))` → `42`）。

EPIPE 那条测试也做了反向验证：**去掉修复后该测试失败**（162ms 后捕获到 EPIPE），确认是真回归测试而非摆设。

---

## 4. 端到端测试

真实模型、真实 fixture、两个场景：

| 检查点 | A 个人决策 | B 外部事实 |
|---|---|---|
| 读了对应技能正文 | ✅ | ✅ |
| `memory_recall` 返回真实记忆内容 | ✅ | — |
| `journal_recall` 带 query 命中条目 | ✅ | — |
| 读到人物档案内容 | ✅ | — |
| 没有瞎找路径 | ✅ | — |
| 跑了 `search.mjs` 并拿到真实结果 | — | ✅ |
| 最终回答非空 | ✅ | ✅ |

调用序列：

```
A  Read → memory_recall → Glob → journal_recall ×3 → Read → decide_reflect ×2 → Read → Bash
B  Read → memory_recall → Bash ×7
```

B 的 7 次 Bash 里 6 次是在反复抓一个 JS 渲染的文档站——已据此在 `web-search/SKILL.md` 补了"抓不到就别硬抓"的说明。

### fixture

`decide-test-workspace/`：**8 天日记 · 4 条记忆 · 1 份人物档案**（被仓库 `.gitignore` 的 `.licode/` 规则整体忽略，不会误提交）。

用真实代码路径播种（`JournalStore` / `parseProfile`+`serializeProfile`），不手写格式。验证：修复前返回 0 条的那个多词查询，现在命中 5 条。

---

## 5. 诊断探针（修复证据，不在测试套件内）

| 探针 | 修复前 | 修复后 |
|---|---|---|
| 日记多词查询 7 例 | 5 例空 | **7/7 命中** |
| Bash 失败丢 stdout | `pwd`/`ls` 输出全丢，只剩一句 `Command failed` | 完整返回（记录第 5 条原样重放验证） |
| 搜索端点 10 个 | 9 个被反爬拦 | DDG lite 稳定可用 |
| thinking 形状 4 变体 | 拆分形状 400 | 合并形状通过 |

**搜索端点是实测选的**：先前 agent 推荐 `html.duckduckgo.com`，实测纯 HTTP 下返回 202 + 反爬挑战页（它当初测通是因为 ego-browser 本身就是真 Chromium）。逐个试下来只有 `lite.duckduckgo.com` 在无浏览器条件下稳定返回结果且无需 API key。

---

## 6. 抖动测量

全量套件跑了约 20 次，结论：

| 现象 | 频次 | 归因 |
|---|---|---|
| 完全干净 | 绝大多数 | — |
| 时序性失败（`mcp/transport`、`curation/dispatch`、`eval-recall/rag-keyword`） | 偶发 | 整包并行下的 CPU 争用。特征是**失败集合每次随机变**，单独跑全部通过 |
| `Unhandled Errors` | 约 2/15 | **已定位并修复**——`hooks/manager.ts:29` 的 EPIPE |

EPIPE 修完后连续 3 次全量运行无 `Errors`，印证了它就是那个抖动源。

---

## 7. 决策业务效果

### 7.1 取证链路：修复后全通

| 环节 | 状态 | 说明 |
|---|---|---|
| 读技能正文 | ✅ | 渐进式披露生效，正文按需加载 |
| `memory_recall` | ✅ | 返回 4 条播种记忆的真实内容 |
| `journal_recall` 多词 | ✅ | 修复前 7/7 全空 → 现在命中 |
| 人物档案 | ✅ | **模型自己 Glob + Read**，`profile_recall` 已删，不需要替代工具 |
| 联网补外部事实 | ✅ | 自主跑 `search.mjs "2027国考报名时间"` |

最后一条值得单独说：**decide 的 prompt 里没有任何跨技能接线**，模型是读了技能书目自己决定去用的。这证明"只给书目、让模型自己翻"的设计成立——不需要在技能之间写引用关系。

### 7.2 `decide_reflect` 的 4 次"未通过"不是失败

先前的判断需要修正。**它是在真实干活，而且被消费了。**

第二轮计划相对第一轮，明确吸收了第一轮的每一条意见：

| 第一轮 reflect 指出 | 第二轮计划的变化 |
|---|---|
| 选项 C 的截止点未定义 | 写入具体日期 `2026-11-30` + 可观测标准 |
| 缺硬窗口日期 | 新增"硬约束"段，并列为要用 web-search 核实的项 |
| 缺中间选项（A/B 二元对立） | 新增 **D 回海南技术岗**、**E 先考公再转** |
| 未把未知项显式列出 | 新增"需用户补的信息"清单 |

而第二轮 reflect 又指出了更深的问题，其中一条特别值得看：

> **缺少"不决策/继续回避"这一实际当前状态的显式评估**

**最终回答正是以这一点开篇的**——"你真正的处境不是犹豫，而是在用回避代替决定"。计划里没有这个洞察，是 reflect 逼出来的。所以那 2 轮上限不是空转，critique 确实改变了输出。

### 7.3 输出质量（唯一一次完整验收）

- 引用了 6 天日记的**具体日期 + 情绪强度**（`堵闷(4)`、`怀疑/两难(4)`），不是泛泛的"你最近压力大"
- **遵守了 feedback 记忆**：播种的记忆里有一条"有倾向就直说，别说看你自己"，回答里确实有独立的「我的倾向」段并给了明确判断
- 联网补了国考时间线，并注明**是预测、以官方公告为准**
- 给了带**止损点**的可执行建议
- 列了 4 条明确的不确定性，且与 reflect 要求补的项对得上
- 走了技能第四步（问要不要记下来）

### 7.4 量化

| 指标 | A 个人决策 | B 外部事实 |
|---|---|---|
| 工具调用 | 11 次 | 8 次 |

**token 算不出来，原因本身是个发现**：`usage` 只在 `finalizeAssistantMessage` 里记，`addToolMessages` 不记。多轮工具循环里，除最后一轮外的用量全部丢弃——session 文件里 18 条消息只有 1 条带 usage，`totalTokens: 4597` 严重偏低。**现在算不出"一次决策花多少钱"**，而这恰恰是决策类功能最该有的度量。

---

## 8. 空白与限制

1. **没有 baseline（最重要）** — 同一道题从未在不加载 decide 技能的情况下跑过。所有"输出质量不错"的观察都**无法归因给这个技能**，一个没有 skill 的 LICode 也可能给出同样好的回答。
2. **样本量** — 1 个决策问题，2 次完整运行。
3. **质量是我判的**，不是用户判的。建议自己读一遍 `verify-e2e-run.md` 的最终回答。
4. **reflect 的 rubric 可能过严** — 它要求"评估考公上岸概率""补充用户技术栈与目标岗位 JD"，这些数据用户根本没提供，任何助手都拿不到。若"通过"实际不可达，2 轮上限就成了默认路径。需要决定：放宽 rubric，还是接受"永远跑满 2 轮"。

---

## 9. 复现方式

脚本都在 `decide-test-scripts/`（从会话临时目录抢救出来的，那个目录会随任务删除而清空）。

```bash
cd /Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure

# 1. 全量测试
pnpm build && npx vitest run

# 2. fixture 体检（不需要 API key）
node decide-test-scripts/verify-fixture.mjs

# 3. 端到端验收（需 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL）
#    关键：工具的工作目录取 process.cwd()，所以必须让进程 cwd == 工作区，
#    脚本里有断言，cwd 不对会直接退出
cd decide-test-workspace && node ../decide-test-scripts/e2e-verify.mjs
```

### 脚本清单

| 脚本 | 用途 | 需要 API key |
|---|---|---|
| `e2e-verify.mjs` | 端到端验收（A 个人决策 + B 外部事实），产出 `verify-e2e-run.md` | 是 |
| `verify-fixture.mjs` | fixture 体检：日记/记忆/档案能否读出、多词查询是否命中 | 否 |
| `seed-diary.mjs` | 用真实 `JournalStore` 播种日记（格式与生产一致） | 否 |
| `seed-profile.mjs` | 用 `parseProfile`/`serializeProfile` 往返更新人物档案 | 否 |
| `probe-journal.mjs` | 日记多词查询修复前后对照 | 否 |
| `probe-bash2.mjs` | Bash 失败路径重放（记录第 5 条原样） | 否 |
| `probe-search.mjs` | 10 个搜索端点可用性探测（选端点的依据） | 否 |
| `probe-thinking6.mjs` | 打原始 `/v1/messages` 验证 thinking 形状（定位根因的关键实验） | 是 |

脚本里的路径是绝对路径，搬到别处需要改常量。

fixture 就绪状态：`decide-test-workspace/` 已含 8 天日记、4 条记忆、1 份人物档案。
