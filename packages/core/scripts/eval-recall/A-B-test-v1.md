# LICode 记忆召回 A/B 测试文档 v1

> 日期：2026-08-18
> 范围：新架构（master，`memory_recall` 工具召回） vs 旧架构（`main-0817`，side-query 两阶段注入）的召回率对比
> 数据与脚本：本目录下 `seed-memories.json`（20 条）、`cases.json`（29 条）、`eval-recall.ts`（新版）、`eval-recall-baseline.ts`（旧版）、`results-*.json`（结果）

---

## 1. 背景与目标

记忆召回系统在 2026-08 完成了重构：从"每轮自动 side-query 注入"（旧架构）改为"主模型自主调用 `memory_recall` 工具"（新架构），动机是提高缓存命中率。此前在 12 条记忆 / 12 条用例的小套件上验收通过（新旧召回率都 100%）。

本测试的目标：

1. 参照 **LoCoMo 基准**（Snap Research, ACL 2024）构造**更多、更复杂**的记忆召回测试场景；
2. 用**同一份数据、同一模型、同一指标**对旧版（`main-0817`）和新版（`master`）做对称 A/B，给出可复现的召回率对比。

---

## 2. LoCoMo 是什么、如何借鉴

### 2.1 LoCoMo 简介

LoCoMo（Long-term Conversational Memory，ACL 2024）评测 LLM 智能体在**跨多天、数百轮**的长期对话中记住并推理信息的能力。其 QA 按问题类型标注，主要分类：

| LoCoMo 分类 | 说明 |
|---|---|
| Single-Hop（单跳） | 直接从某一次对话/会话中检索一个事实 |
| Temporal（时序/知识更新） | 事件排序、"某观点何时改变"、事实随时间的演化 |
| Multi-Hop（多跳） | 综合多个会话/片段的事实进行推理 |
| Open-Domain（开放域） | 结合对话上下文与世界知识 |
| Adversarial（对抗） | 问题看似可答但对话中并不存在；系统应**弃权**（防幻觉） |

### 2.2 从"问答评测"到"召回评测"的改造

LoCoMo 测的是**最终回答质量**（LLM-judge 打分）；而 LICode 记忆系统的"生产层"（对话 → 记忆文件）已完成，我们需要聚焦**召回层**——即"该用的记忆有没有被取回"以及"不该取回的记忆有没有被误取回"。

改造方式：

1. **对话压缩为记忆集**：LoCoMo 的长对话在进入 LICode 记忆系统时已被提炼成 memory 文件，所以评测直接用"一组 seed 记忆"作为记忆库，模拟长期对话沉淀下来的事实。
2. **问题分类映射为召回断言**：把 LoCoMo 每类问题改写成"这个查询**应当召回哪条记忆**"（A 组）或"**不应召回任何记忆**"（B/D 组）。
3. **补两个召回系统特有的维度**：LoCoMo 未单列、但对召回层关键的——**语义陷阱**（关键词撞车但实际无关，即 RAG 硬伤）与**多跳召回**（一次查询需要命中多条记忆）。
4. **对抗类照搬**：查询看似有答案、记忆库里不存在 → 正确行为是**弃权、不联想**。

---

## 3. 测试套件构成

### 3.1 数据

- **seed-memories.json：20 条**（原 12 条 + 新增 8 条）
  - 类型：user（用户偏好/计划/个人信息）9 条、feedback（反馈）4 条、project（项目理解）3 条、reference（外部资料）4 条
  - 新增的 8 条：`food-sugar-restriction`（戒糖）、`fitness-schedule-new`（晨练新安排）、`contact-info`（联系方式）、`team-relationships`（团队分工）、`vacation-plan`（云南年假）、`reading-list`（在读）、`concise-answers`（简洁回答）、`docker-cheatsheet`（Docker 备忘）
  - **知识更新对**（同主题新旧两条并存，用于测"取当前状态"）：
    - 旧 `fitness-schedule`（周三周五晚）↔ 新 `fitness-schedule-new`（周一四早 6:30）
    - 旧 `food-preferences`（爱吃甜）↔ 新 `food-sugar-restriction`（2026-07 起戒糖）
  - **干扰项**：`docker-cheatsheet`、`reading-list`、`team-relationships` 等不与多数查询相关的记忆，增大检索难度，更接近真实场景。

### 3.2 用例

- **cases.json：29 条**，分四组：A 11 / B 8 / D 4 / C 6。
- 每组各配 `expectedSlugs`（应命中的记忆）与 `expectRecall`（是否应触发召回）。

### 3.3 对称性与可复现性

- 两版使用**同一份** seed + cases、**同一模型**（deepseek-chat）、**同一 temperature（0）**。
- 新架构脚本：`eval-recall.ts --mode=tool`（主模型自主决定是否调 `memory_recall`，再从工具返回解析选中 slug）。
- 旧架构脚本：`eval-recall-baseline.ts`（直接调 `MemoryRecall.select()`，等价于旧架构每轮自动注入的 side-query 选摘）。该脚本依赖旧版 `memory/recall.ts`，需在 `main-0817` checkout 下运行。

### 3.4 指标定义

| 指标 | 定义 | 说明 |
|---|---|---|
| **recallA（A 组召回率）** | A 组中 `expectedSlugs ⊆ selectedSlugs` 的比例 | 该召回时是否召回了（正确 + 可能多余） |
| **falsePositiveB（B 组误召回率）** | B 组中触发召回（调用工具/注入记忆）的比例 | 不该召回时是否触发了 |
| **precision（选中准确率）** | 选中的 slug 中属于全局 expected 集合的比例 | 全局口径，偏乐观（已知限制） |
| **fabricateD（D 组幻觉联想率）** | D 组中选中任意记忆的比例 | 记忆不存在时是否"联想"出无关记忆（LoCoMo 对抗类要求 abstain） |
| C 组 | 只记录不判分（`expectRecall=null`） | 探索性用例 |

---

## 4. 测试用例分类与测试意图

### 4.1 A 组：应当召回（11 条）

正确行为：**召回相关记忆**。按 LoCoMo 场景再细分：

| 子类 | 用例 | 查询（期望命中的记忆） | 测什么 |
|---|---|---|---|
| **单跳·直接检索** | a1 | 宵夜吃什么好？（food-preferences） | 提到用户偏好时直接命中 |
| | a2 | 回复风格注意点（conclusion-first） | 提到反馈要求时直接命中 |
| | a3 | 什么时候上线（q3-launch） | 提到项目计划时直接命中 |
| | a4 | 这周哪几天晚上有空锻炼（fitness-schedule） | 提到"晚上"的时间约束时命中**旧**健身安排 |
| | a5 | 默认用哪个模型（deepseek-default） | 提到项目配置时直接命中 |
| **时序·知识更新** | a6 | 现在健身还是周三周五晚上吗（fitness-schedule-new） | 新旧并存时取"当前"状态 |
| | a7 | 还能随便吃甜的吗（food-sugar-restriction） | 新旧并存时取"当前"状态（戒糖） |
| **多跳·跨类型** | a8 | 8 月底去云南，之前能定下 Q3 上线吗（vacation-plan + q3-launch） | 一次查询需同时命中个人计划 + 项目计划两条记忆 |
| **隐指·跨会话** | a9 | 上次说的记忆召回重构（memory-redesign） | 代词/隐指"上次说的那个"能否召回被指的项目记忆 |
| **个人细节** | a10 | 手机号多少，填报名表（contact-info） | 敏感个人信息能否被精确召回 |
| **关系·人员** | a11 | 现在后端谁负责（team-relationships） | 人员/分工类记忆 |

### 4.2 B 组：不应召回（8 条）

正确行为：**不触发召回**（不调用工具/不注入记忆）。两个子类：

| 子类 | 用例 | 查询 | 测什么 |
|---|---|---|---|
| **纯技术·无状态** | b1–b4 | Readonly/as const；防抖函数；git rebase/merge；正则邮箱 | 无状态技术问答不应触发记忆召回 |
| **语义陷阱（关键词撞车）** | b5 | 给健身 App 设计数据库表（"健身"撞 fitness 记忆） | 关键词相似但语义无关时能否忍住不召回 |
| | b6 | DeepSeek 股价走势（"DeepSeek"撞 deepseek-default / deepseek-docs） | 世界知识/新闻问题不应召回个人项目记忆 |
| | b7 | Neovim 的 lua 配置入门（"neovim"撞 neovim-workflow） | 通用技术教程不应召回用户自身编辑器偏好 |
| | b8 | docker compose 的 depends_on/volumes（"docker"撞 docker-cheatsheet） | 通用 docker 问题不应召回个人备忘 |

> 语义陷阱对应 LoCoMo 开放域 + 对抗的"看着相关其实无关"，也是记忆系统参考文章中点名的 **RAG 硬伤**。

### 4.3 D 组：对抗·防幻觉联想（4 条）

正确行为：**弃权**——不召回任何记忆（记忆库里没有对应事实）。

| 用例 | 查询 | 测什么 |
|---|---|---|
| d1 | 我的宠物狗叫什么名字？ | 个人细节不存在时是否联想出无关记忆 |
| d2 | 上次说的房贷利率是多少？ | 金融细节不存在时是否联想 |
| d3 | 我女朋友的生日是什么时候？ | 关系细节不存在时是否联想 |
| d4 | 我在招行存了多少定期？ | 资产细节不存在时是否联想 |

> 对应 LoCoMo Adversarial 类（约占其 45% 样本量）：系统应 abstain，召回任何无关记忆都算幻觉联想。

### 4.4 C 组：探索性（6 条，不计分）

| 用例 | 查询 | 期望（仅参考） |
|---|---|---|
| c1 | 最近有什么值得关注的记忆系统研究？ | locomo-paper |
| c2 | 我这个项目最近的重点是什么？ | memory-redesign |
| c3 | 想找篇之前看过的记忆系统对比文章 | zhihu-memory-article |
| c4 | 规划接下来两周，避开锻炼和出行 | fitness-schedule-new + vacation-plan |
| c5 | 对比现在和以前对甜食的态度 | food-preferences + food-sugar-restriction |
| c6 | 最近在学什么技术？ | reading-list |

---

## 5. 执行环境

| 项 | 值 |
|---|---|
| 模型 | `deepseek-chat`（DeepSeek Anthropic 兼容端点 `https://api.deepseek.com/anthropic`） |
| temperature | 0 |
| 凭证 | `~/.claude/settings.json` env 中的 `ANTHROPIC_AUTH_TOKEN`（Claude Code 注入，非 shell 导出） |
| 种子记忆加载 | 两版均 20/20 条解析成功 |
| 运行次数 | 旧版 3 次（完全一致，确定性）；新版 2 次（A/D 稳定、B 稳定、具体选中记忆有抖动） |

复跑命令：

```bash
# 新版（master worktree 内）
EVAL_MODEL=deepseek-chat pnpm tsx packages/core/scripts/eval-recall.ts --mode=tool
# 旧版（main-0817 checkout 内，将本目录数据与 eval-recall-baseline.ts 一并复制过去）
EVAL_MODEL=deepseek-chat pnpm tsx packages/core/scripts/eval-recall-baseline.ts
```

---

## 6. A/B 测试结果（总结）

### 6.1 总体对比（deepseek-chat，temperature 0）

| 指标 | 新版（master·工具召回） | 旧版（main-0817·side-query） | 差异 |
|---|---|---|---|
| **recallA（A 组召回率）** | **100%**（11/11） | **91%**（10/11） | 新版 +9pp |
| **falsePositiveB（B 组误召回率）** | **50%**（4/8） | **13%**（1/8） | 新版 +37pp（更差） |
| **precision（选中准确率）** | 85–87% | 83% | 新版略优 |
| **fabricateD（D 组幻觉联想率）** | **0%**（0/4） | **0%**（0/4） | 持平 |

### 6.2 场景拆解

**A 组按子类**：

| 子类 | 新版 | 旧版 |
|---|---|---|
| 单跳·直接检索（a1–a5） | 5/5 | 4/5（**a4 漏**） |
| 时序·知识更新（a6–a7） | 2/2 | 2/2 |
| 多跳（a8） | 1/1 | 1/1 |
| 隐指（a9） | 1/1 | 1/1 |
| 个人细节（a10）/ 关系（a11） | 1/1 / 1/1 | 1/1 / 1/1 |

**B 组按子类**：

| 子类 | 新版 | 旧版 |
|---|---|---|
| 纯技术（b1–b4） | 1/4（b2 空触发） | 0/4 |
| 语义陷阱（b5–b8） | 3/4（b5/b6/b7） | 1/4（b7） |

### 6.3 关键发现

1. **新版召回更全**：知识更新、多跳、隐指、个人细节、关系等复杂场景全部命中；旧版在 **a4 漏召回**——"这周哪几天**晚上**有空锻炼？"，旧 side-query 只召回了新晨练安排（周一四**早上**），无视查询的"晚上"约束，漏了周三周五晚的旧安排。表现为"偏好 recency 但读不懂时间约束"。
2. **新版误触发明显更高**：语义陷阱上主模型过度调用 `memory_recall`、子代理把关键词相关但无关的记忆召回——b5（健身 App 数据库）召回了团队分工/编辑器/健身 5 条无关记忆；b7（Neovim 入门）召回 neovim-workflow；b6（DeepSeek 股价）空触发浪费一次调用。旧 side-query 的 prompt 默认保守（"不确定不新增"），B 组近乎零误召回。
3. **对抗弃权两版都合格**：对"宠物狗名字/房贷利率/女友生日/招行存款"这类记忆里不存在的事实，两版都选择弃权不联想（fabricateD 均 0%）。
4. **非确定性是新架构特性**：b2（防抖函数）主模型"是否调用工具"多次运行有抖动；旧架构 3 次运行字节级一致。模型驱动召回的多步决策路径天然更多变。
5. **原 12 例小套件太易**：原套件 B 组对两版都是 0% 误触发；本次新增的语义陷阱用例才暴露新版误触发弱点——套件扩充达到了目的。

### 6.4 与原始套件（kimi-k3）对比

| 套件 | 模型 | 新版 A/B/acc/D | 旧版 A/B/acc/D |
|---|---|---|---|
| 原 12 记忆/12 用例 | kimi-k3 | 100% / 0% / 86% / – | 100% / 0% / 71% / – |
| 本次 20 记忆/29 用例 | deepseek-chat | **100% / 50% / 85–87% / 0%** | **91% / 13% / 83% / 0%** |

---

## 7. 结论与遗留

- **结论**：新架构在"该召回时召回得更全"（100% vs 91%），且对抗防幻觉合格；代价是"不该召回时误触发更多"（50% vs 13%），主要落在语义陷阱与技术问题上。
- **遗留 1**：新版 B 组误触发高，指向两个提示词优化点——主模型工具调用判据 + 子代理相关性过滤。本测试只做测量，未改动提示词。
- **遗留 2**：`precision` 用全局 expected 并集做分母，仍偏乐观（对单条用例的准确率参考意义有限）。
- **遗留 3**：gitee 推送需交互凭证，本次仅 commit（分支 `worktree-recall-ab-test`，commit `6e1cda9`）。

---

## 8. 第二轮回测（用户指定双 key，2026-08-18）

按用户要求，用两个独立 API key 各跑一轮（端点、模型、temperature、数据均不变）：

| 版本 | 使用的 key | 结果文件 |
|---|---|---|
| 新版（master·工具召回） | `sk-9108…fff3` | `results-tool-newkey.json` |
| 旧版（main-0817·side-query） | `sk-62b2…eef5a` | `results-baseline-oldkey.json` |

### 8.1 两轮回测汇总

| 指标 | 新版 round1（共享 key） | 新版 round2（key1） | 旧版 round1（共享 key） | 旧版 round2（key2） |
|---|---|---|---|---|
| **recallA** | 100% | **100%** | 91% | **91%** |
| **falsePositiveB** | 50% | **63%** | 13% | **13%** |
| **precision** | 85–87% | **86%** | 83% | **83%** |
| **fabricateD** | 0% | **0%** | 0% | **0%** |

### 8.2 第二轮回测要点

1. **旧版跨 key 完全稳定**：round2（key2）与 round1（共享 key）的逐条结果一致——同一处 a4 漏召回、同一处 b7 误触发。旧架构的 side-query 选摘是确定性的，与所用 key 无关。
2. **新版跨 key 有波动**：round2 的 B 误召回率升到 63%（5/8），新增 **b8（docker compose 问题）** 这次也误触发，并注入了 5 条无关记忆（含 docker-cheatsheet、memory-redesign、q3-launch 等）。A 组 100%、D 组 0% 两轮保持一致。
3. **结论不变**：新旧差异来自**架构本身**（新版模型驱动的"是否调工具"决策更激进且非确定，旧版保守确定），不是 key 差异造成的。新版"召回更全、误触发更高"的结论在双 key 下均成立。
