# 记忆检索元数据质量优化设计：类型选择 + description/keywords 富索引

> **日期**：2026-08-04
> **状态**：设计中（brainstorming 产出，待审阅）
> **前置文档**：[记忆系统重构设计](2026-07-27-memory-system-redesign-design.md)（生产/召回/整理/反馈四层，本设计在其之上收紧"检索元数据质量"）
> **范围**：A 类型选择松 + B description 召回瓶颈，一个文档分期实施（A 先 B 后），但富索引格式一次定死

---

## 1. 背景与问题

### 1.1 统一视角

记忆的"检索画像" = `{ type, description, keywords }`。当前这套元数据在**写入时**既没定义好、也没校验，而**召回又完全依赖它**做选择。两个瓶颈同源，故合并为一个设计：

- **A** 让 `type` 准（画像的类别维度）
- **B** 让 `description + keywords` 好用（画像的检索维度）

两者都在**写入侧**做准（prompt 定义 + `save()` 校验），读取侧最小改。

### 1.2 问题 A：类型选择松

**已验证的代码事实**：

- `extractor.ts:271-282` 的提取 prompt 只在输出格式里列出 `user|feedback|project|reference` 四个类型名（272 行），**不定义各自含义**；唯一例外是 feedback 有一条 Why/How 结构要求（277 行）。
- `dream.ts:361-370` 的 consolidate prompt 同样只说"遵守四分类"，不展开定义。
- `store.save()`（`store.ts:46-47`）**连枚举校验都没有**，直接 `path.join(this.dir, memory.type)` 拼路径写入。
- `memory-guide.md:15-23` 定义了全部 4 类，但那是给**主 Agent** 看的，后台 extractor/dream 的 prompt 不带这些定义。

**后果**：类型由 LLM 凭类型名字面意思自由心证，**类型边界模糊、feedback 尤其易漏**（它最窄、最需要 Why/How 结构约束）。

> **动机措辞校正**：早期讨论曾用"治全往 user 塞"。该说法证据不够硬——8 条存量记忆里 6-7 条是 user，但这被测试数据（个人聊天本就 user 型）干扰，无法证明是系统性偏置。能确定的是 prompt 无定义导致边界模糊、feedback 易漏。本设计治的是后者，不依赖"全往 user"是否已被数据证实。

### 1.3 问题 B：description 召回瓶颈

**已验证的代码事实**：

- 召回是**生产/召回不对称**的：生产侧 extractor 看得到全部现有记忆正文（`extractor.ts:251-254`：`### slug\nname\ndescription\ncontent:全文`），召回侧 `recall.ts` 的 side-query 小模型选记忆时**只看 MEMORY.md 索引里的一行 description，看不到正文**。
- extractor prompt 对 description 只说"一句话描述"（`extractor.ts:272`），**没有"写成利于检索的 key"的指导**。
- 实际 description 参差：有叙事型（混入无关话题易误匹配，如"跳槽"那条混入竞赛/学生会）、有未归一化的相对日期（"下个月"）、有提取 artifact（"2026年（2026年）"）。
- dream Prune（`dream.ts:458-514`）只在索引超 200 行/25KB 时把 description LLM 缩到 ≤150 字符（失败降级 `slice(0,150)`），**只管长度不管质量**。

**后果**：description 是召回唯一相关性信号却没按这个职责优化，是召回准确率瓶颈。

### 1.4 keywords 命名消歧义

`dream.ts:174/197/568` 已存在 `keywords` 字段，但那是**漂移怀疑线索词**（Orient 阶段产出、Gather 用来 grep 证据），**不是 per-memory 检索键**。本设计引入的 per-memory `keywords` 是新概念，不与现有冲突，但文档与代码注释需注明二者区别。

---

## 2. 设计

### 2.1 A 类型选择 = soft（提示词决策树）+ hard（save() 校验）

**Soft** — 把 `memory-guide.md` 的四类定义以**决策树**搬进 `extractor.ts:271-282` 和 dream consolidate prompt（`dream.ts:361-370`），判别顺序：

1. **feedback** — 用户明确纠正/确认过的协作方式（content 必含 `Why:` / `How to apply:`）
2. **reference** — 外部系统入口（看板/频道/URL/账号）
3. **project** — 代码与 git 推导不出的项目背景/决策/截止日期
4. **user** — 兜底（用户是谁：角色/经验/偏好/目标）

先判最窄易漏的 feedback、再特征明显的 reference、兜底 user，治类型边界模糊与 feedback 易漏。

**Hard** — `store.save()`（`store.ts:46`）入口加两道闸：

- **枚举校验**：`type ∉ {user,feedback,project,reference}` → 拒绝写入该条 + 记日志（extractor 的 per-item try/catch 兜住，不波及同批其他记忆，也不建 `memory/<脏type>/` 目录）。
- **feedback 结构契约**：`type=feedback` 但 content 缺 `Why:` 或 `How to apply:` → **降级为 user**（同步把 slug 前缀 `feedback/` 改 `user/`）。不 reject（不丢用户刚说的信息），降级保信息、纠正类型，dream 后续可补结构再提回 feedback。

frontmatter 的 `type` 字段不变（仍四选一），只是写入时有校验闸。

### 2.2 B description + keywords + 富索引

**关键设计洞察（比原计划更省）**：`recall.ts:131` 的 `select()` **已经调 `listAll()` 把所有记忆（含全文）读入内存**。所以富索引**不必改 MEMORY.md** — recall 在内存里从 listAll 结果构造"description + keywords + 正文首行"喂给 side-query 即可。MEMORY.md（系统提示词 memory 层在用）保持 description-only、轻量不变。由此：

- 系统提示词 memory 层**不涨 token**（还是一行 description）。
- dream Prune **不用改**（它只管 MEMORY.md 的 description，keywords 不进 MEMORY.md）。
- "索引格式一次定死"自然满足 — MEMORY.md 全程不改，富格式是 recall 内部一次定义。

**keywords 字段（新）**：

- `types.ts`：`Memory` 加 `keywords?: string[]`（optional，为 lazy 迁移）。
- `store.ts` `parse()` / `save()`：读写 frontmatter `keywords:` 行（`save()` 落盘处 `store.ts:108-113`）。
- `extractor.ts:272` + dream consolidate prompt：产记忆时输出 2-5 个判别性关键词（四类都要，不限 feedback）。

**description 检索指导**（`extractor.ts:272` 加规则）：

- 写成检索 key：一句话、含判别性词、**不叙事、不混无关话题**、≤~40 字（治当前叙事型混入无关话题）。
- 相对日期转绝对（已有规则 `extractor.ts:280`，强化执行）。

**富索引构造**（`recall.ts` `select()` 内）：

- 从 `listAll()` 结果，每条拼：`name - description [关键词: kw1,kw2] 「正文首行≤60字预览」`（首行 = content 按 `\n` 切的第一行，超出 60 字截断 + `…`）
- 喂给 side-query prompt（替换原 `loadIndex()` 的 indexContent — 连 `select()` 里那步 `loadIndex()` 都可省掉，数据 listAll 全有）。
- 无额外 LLM 调用，仍是单次 side-query。recall prompt 加一句说明新格式，让小模型知道有关键词/预览可参考。
- 缺 keywords 的旧记忆：该段省略，不影响。

**lazy 迁移**：存量记忆无 keywords — recall 兼容（省略该段）；dream consolidate 触到时补 keywords。

---

## 3. 数据流

### 3.1 写入路径（生产）

```
agent loop 结束 -> after:agentLoop hook -> shouldExtract 闸 -> extractor
  prompt 现在带:[新]类型决策树 + [新]description 检索指导 + [新]keywords 产出要求
  LLM 输出 [{action, slug, type, name, description, keywords, content}]
  -> store.save():
       [新]枚举校验:type∉四类 -> 拒绝+日志
       [新]feedback 契约:type=feedback 缺 Why/How -> 降级 user(同步 slug 前缀)
       落盘 frontmatter(含 keywords 行)+ rebuildIndex(MEMORY.md 仍 description-only)
```

### 3.2 读取路径（召回）

```
onTurnStart:刷新 memory 系统提示词层(MEMORY.md,description-only,不变)-> 剪旧召回对
  -> recall.select():listAll() 拿全部(含 keywords+content)
       [新]构造富索引:name - description [关键词: kw] 「首行≤60字」
       side-query 单次看富索引+query -> 选 slug(省掉原 loadIndex)
  -> 注入选中正文(合成 tool_call 对)+ recordUsage
```

### 3.3 主 Agent 直写路径（关键补丁）

用户说"记住"时主 Agent 用 Write 直写 `.licode/memory/<type>/<slug>.md`，**绕过 `save()`**，校验闸够不着。现有 `normalizeChangedSince`（`store.ts:236-244`）会归一化直写文件（重写 name/description/frontmatter）。

**设计**：校验逻辑放共享处（如 `validateMemory()` 辅助函数），`save()` 和 `normalizeChangedSince` 都调。主 Agent 直写路径下：

- enum 违规 → 记日志（不宜删 Agent 写的文件，留给 dream 整理）。
- feedback 缺 Why/How → 降级 user（同步 slug 前缀）。

---

## 4. 错误处理

| 情况 | 处理 |
|---|---|
| 枚举不合法（extractor 路径） | `save()` 拒绝写该条 + 记日志，per-item try/catch 兜住，不波及同批 |
| feedback 缺 Why/How | 降级 user（slug 前缀 `feedback/`→`user/`），内容不丢，dream 后续可补结构 |
| 主 Agent 直写 enum 违规 | `normalizeChangedSince` 记日志（不删文件），feedback 缺结构降级 |
| 旧记忆缺 keywords | recall 富索引省略关键词段，不报错；dream 触到时补 |
| keywords frontmatter 解析错 | `parse()` 容错，keywords 视为 `[]` |
| recall side-query 失败/超时 | 不变（已有 10s 超时 + 降级仅索引）；富索引是纯内存拼接，不会失败 |

---

## 5. 测试

**单测（稳定）**

- `save()` 枚举：`type="foo"` → 拒绝、不建 `memory/foo/`。
- feedback 降级：`type=feedback` 缺 `Why:` → 降级 user + slug 前缀改；含 Why+How → 正常存。
- keywords 读写：save 带 keywords → load 回来一致；frontmatter 错 → keywords=`[]`。
- 富索引构造：mock listAll，断言含 description+keywords+首行；首行>60 字 → 截断+省略号；缺 keywords → 省略段不报错。
- 主 Agent 直写校验：mock normalizeChangedSince，enum 违规记日志、feedback 缺结构降级。

**集成（LLM 依赖，标注不稳）**

- 决策树：对话"以后都用 pnpm" → 产出 type=feedback（不被分 user）。
- dream consolidate 给无 keywords 记忆补 keywords。

**验收标准**

- feedback 不再因 prompt 无定义漏分（prompt 有决策树定义）。
- 枚举违规不建脏目录。
- 新产出 description 是检索 key 型（非叙事），含判别词。
- recall 能看到 keywords+首行（precision 提升靠抽样人工评，难量化）。

---

## 6. 分期实施

**Phase A（类型，先）**

- `extractor.ts` + `dream.ts`：加类型决策树定义。
- `store.ts`：`save()` 加枚举校验 + feedback 降级；`normalizeChangedSince` 补校验（共享 `validateMemory()`）。
- `memory-guide.md`：加决策树（主 Agent 也按此写）。
- 测试：枚举/feedback 降级单测 + 决策树集成。

**Phase B（description + keywords + 富索引，后）**

- `types.ts`：`keywords?: string[]`；`store.ts`：parse/save 读写 keywords。
- `extractor.ts` + `dream.ts`：prompt 产 keywords + description 检索指导。
- `recall.ts`：`select()` 构造富索引（省 loadIndex）+ prompt 适配。
- `memory-guide.md`：加 keywords 模板 + description 指导。
- dream：Prune 不改（MEMORY.md 不变）；consolidate 补 keywords。
- 迁移：lazy（dream 触发补）。

**"索引格式一次定死"**：MEMORY.md 全程不改（Phase A 不碰，Phase B 也不碰），富索引是 recall 内部一次定义。无"改两遍"风险。

---

## 7. 涉及文件

| 文件 | 变更 | 阶段 |
|---|---|---|
| `packages/core/src/memory/extractor.ts` | prompt 加类型决策树定义 + description 检索指导 + keywords 产出要求 | A+B |
| `packages/core/src/memory/dream.ts` | consolidate prompt 加决策树 + keywords 产出；Prune 不改；consolidate 补 keywords | A+B |
| `packages/core/src/memory/store.ts` | `save()` 加枚举校验 + feedback 降级；`parse()`/`save()` 读写 keywords；`normalizeChangedSince` 补校验；共享 `validateMemory()` | A+B |
| `packages/core/src/memory/types.ts` | `Memory` 加 `keywords?: string[]` | B |
| `packages/core/src/memory/recall.ts` | `select()` 构造富索引（省 loadIndex）+ prompt 适配 | B |
| `packages/core/src/conversation/templates/memory-guide.md` | 加类型决策树 + keywords 模板 + description 指导 | A+B |
