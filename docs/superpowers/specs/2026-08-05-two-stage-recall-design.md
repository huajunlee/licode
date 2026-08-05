# 两阶段召回设计:side-query 被动召回 + memory_fetch 主动召回

> **日期**:2026-08-05
> **状态**:设计中(brainstorming 产出,待审阅)
> **前置文档**:
> - [记忆系统重构设计](2026-07-27-memory-system-redesign-design.md)(生产/召回/整理/反馈四层,本设计改"召回层")
> - [记忆检索元数据质量优化设计](2026-08-04-memory-retrieval-metadata-design.md)(写入侧索引质量,与本设计正交互补)
> **范围**:在现有 side-query(第一阶段)之上,新增 `memory_fetch` 工具(第二阶段),并引入统一"已加载记忆注册表"解决双向去重 + 选择性剪除。

---

## 1. 背景与问题

### 1.1 现状:单阶段 side-query 召回

召回由 `MemoryRecall`(`packages/core/src/memory/recall.ts`)实现,挂载在 `AgentConfig.onTurnStart`(`packages/core/src/agent/loop.ts:107-111`),每轮用户发言后、主 LLM 调用前自动执行:

1. 刷新索引层:把 `MEMORY.md` 以 `priority: 5` 灌进 system prompt(`recall.ts:242-255`)。
2. 剪除:`pruneRecallMessages` 无条件全剪上一轮的合成 `memory_recall` pair(`recall.ts:257-262`、`recall.ts:26-51`)。
3. side query:`select(userQuery, store)`(`recall.ts:126`)用一个独立 provider 实例(与主模型同 model id,默认 `deepseek-chat`)发一次 LLM 调用,从索引选 ≤5 条相关记忆。
4. 注入:`buildRecallPair`(`recall.ts:55-89`)把选中记忆包成合成 `tool_use(memory_recall) + tool_result` 追加进主对话(`recall.ts:286-287`)。

### 1.2 问题 A:上下文盲区

`select` 入参只有当前 userQuery + store,**不接收 conversation/历史**(`recall.ts:126`)。`createMemoryRecallHandler` 取 query 仅取最后一条 user 消息纯文本(`recall.ts:266-271`)。side-query prompt 只含"索引 + 当前消息"(`recall.ts:171-200`),**看不到任何历史对话**。

后果:记忆最该被用上的"继续上次那个方案""按之前约定改"等多轮上下文场景,side-query 只凭当前一句话判断,容易漏召回。

### 1.3 问题 B:无主动召回通路

`memory_recall`(`recall.ts:15`)仅是合成注入用的 tool_use name,**未注册为真实工具**(全仓 grep 仅 `recall.ts` 与 `index.ts` 导出提及,`builtinTools`/`ToolRegistry` 无此工具)。主模型无法主动触发召回,只能被动接收 side-query 注入的内容。现有兜底是"主 Agent 用 Read 翻 `.licode/memory/`"(user-guide:888),粗糙且无去重/记账。

### 1.4 两阶段召回的动机

引入第二阶段:主模型读到 system prompt 中的 MEMORY.md 索引(已知每条 slug),结合**完整对话上下文**判断需要某条记忆正文时,主动调用 `memory_fetch` 工具按 slug 精确取回。第一阶段(side-query)保留为 always-on 兜底,第二阶段(memory_fetch)作精度补强--补 side-query 的上下文盲区。

---

## 2. 关键决策(brainstorming 确认)

| 决策点 | 选择 | 理由 |
|---|---|---|
| 范围 | 在最小混合(加 memory_fetch 工具)基础上,因修复重复漏洞而扩展为召回 lifecycle 重设计 | 修复重复漏洞必须让 side-query 感知 memory_fetch,放宽"原样不动" |
| 工具名 | `memory_fetch` | 避开合成注入占用的 `memory_recall`(`recall.ts:15`),不与 `journal_recall`/`profile_recall` 混 |
| 参数 | `{ slugs: string[] }` | 主模型已从索引看到 slug,精确、零额外 LLM,`store.load(slug)` 取正文 |
| 统一层 | 会话级 HashMap(`LoadedMemoryRegistry`) | O(1) 查询,session 恢复时 rebuild;容纳 side-query + 主动召回所有记忆并标记来源 |
| select 语义 | 反转默认:输出 `{ add, prune }` | 已加载 side-query 默认保留,select 明确判无关才剪;漏输出=保留(安全),消除"误剪相关"隐患 |
| retain 上限 | 新注入 ≤ maxResults(5),已加载相关保留无上限 | 灵活,相关记忆跨轮保留;token 有界于相关集合 |
| 主动召回生命周期 | 不剪除(正常 tool_result 留历史) | `memory_fetch` ≠ `memory_recall`,`pruneRecallMessages` 天然不剪(`recall.ts:31`) |
| 引导 | 软引导 | 改 `memory-guide.md:62` + 工具 description;不动 side-query、不动 memory layer 内容 |
| 开关 | `LICODE_MEMORY_RECALL=off` 时 memory_fetch 不注册 | 两阶段共用开关,off=完全关闭召回,退回纯索引+Read |

---

## 3. 设计

### 3.1 统一层:`LoadedMemoryRegistry`(会话级 HashMap)

容纳当前会话已加载的所有记忆,标记来源,提供 O(1) 查询。

```ts
type Source = "sidequery" | "active";

class LoadedMemoryRegistry {
  private map = new Map<string, Source>();
  has(slug: string): boolean;                 // O(1)
  get(slug: string): Source | undefined;
  add(slug: string, source: Source): void;    // 覆盖旧 source
  remove(slug: string): void;
  getAll(): Array<{ slug: string; source: Source }>;
  /** session 恢复时扫消息重建 */
  rebuild(messages: Message[]): void;
}
```

- **归属**:独立对象,`hooks.ts` 用 `useRef(createLoadedMemoryRegistry())` 创建,闭包共享给 `createMemoryRecallHandler` 与 `createMemoryFetchTool`。与 `dreamState`(`hooks.ts:409`)同模式,**不改动 `ConversationManager`**。
- **生命周期**:新建 session 初始空;`ConversationManager.load` 之后(`hooks.ts:482` 附近)立即 `registry.rebuild(manager.getMessages())` 重建;运行中 add/remove 维护。**O(1) 查询,仅 session 恢复扫一次消息。**
- **rebuild 实现**:扫消息,按 `tool_use` 的 name 配对 tool_result,正则 `/^## .* \(([^)]+)\)$/m` 解析 `## name (slug)` 标记(格式源自 `buildRecallPair`,`recall.ts:66`),按 name 标来源:`memory_recall` -> `sidequery`,`memory_fetch` -> `active`。

### 3.2 select 新语义(反转默认:判剪除)

签名从 `select(userQuery, store)` 改为 `select(userQuery, store, loaded: Array<{slug, source}>)`(`recall.ts:126`)。

select 现做两件事,输出双字段:

```ts
{ add: string[];    // 新注入的 slug(≤ maxResults,从索引选相关且**未加载**的新记忆)
  prune: string[] } // 应剪除的已加载 side-query slug(明确判与当前问题无关的)
```

- **active(主动召回)不参与 prune 判断**(永不剪)。
- prompt 改为:输入"当前 query + 索引 + 已加载列表(含来源)",输出 `add`(相关且未加载的新记忆,≤5)+ `prune`(已加载 side-query 中明确与当前无关的)。
- **默认保留**:已加载 side-query 记忆只要没被 select 明确放进 `prune`,就保留(跨轮)。这把"漏输出"的后果从"误剪"降级为"保留",消除误剪隐患。

### 3.3 prune 新逻辑(选择性剪)

新函数 `pruneIrrelevantRecallMessages(messages, pruneSlugs, registry)` 取代现行 `pruneRecallMessages`(`recall.ts:26-51`,无条件全剪):

- 合成 `memory_recall` 对里,slug ∈ `pruneSlugs` -> **剪**,`registry.remove(slug)`
- slug ∉ `pruneSlugs` -> **保留**(跨轮)
- `memory_fetch` tool_result(active)-> **一律不剪**

### 3.4 `memory_fetch` 工具

工厂模式创建(`ToolContext` 无 store/conversation,`packages/core/src/tools/types.ts`,必须闭包注入,与 `MemoryExtractor` 接线风格一致):

```ts
createMemoryFetchTool({ store, conversation, registry }): Tool
```

`execute({ slugs })`:
1. 对每个 slug:`registry.has(slug)` -> 跳过(返回"已在上下文"提示)
2. 未加载:`store.load(slug)`(`store.ts:168`,null 则跳过)+ `store.recordUsage(slug)`(`store.ts:362`,best-effort)+ `registry.add(slug, "active")`
3. 按 `## name (slug)\ncontent` 格式(`buildRecallPair` 同款,`recall.ts:66`)拼接,多条 `\n\n` join,返回 `{ status: "success", content }`

工具 description(软引导核心):
> 按 slug 精确取回已索引记忆的完整正文。相比 Read:已加载的自动跳过(去重)、记入用量(影响归档)、按召回格式返回无行号。用于你在记忆索引中看到 slug 且需要正文的场景。模糊搜索用 Grep,非记忆文件用 Read。

### 3.5 onTurnStart 新流程(`createMemoryRecallHandler` `recall.ts:229` 改)

1. 刷新索引层(不变,`recall.ts:242-255`)
2. `loaded = registry.getAll()`(O(1),不扫消息)
3. `retain = await select(query, store, loaded)` -> `{ add, prune }`
4. prune:剪 `prune` 中的 side-query 合成对,`registry.remove(slug)`;active 不剪
5. 注入 `add`(≤5),`registry.add(slug, "sidequery")`

### 3.6 一致性维护点(状态同步,关键)

| 事件 | registry 操作 |
|---|---|
| memory_fetch 加载 | `add(slug, "active")` |
| side-query 注入新 | `add(slug, "sidequery")` |
| prune 剪 side-query 无关 | `remove(slug)` |
| 主动召回 | 永不 `remove` |
| session 恢复 | `rebuild(messages)` |

### 3.7 开关与引导

- **开关**:`LICODE_MEMORY_RECALL=off` 时,side-query onTurnStart 不挂(现行,`hooks.ts:716-718`/`782-784`)**且 memory_fetch 不注册**。off = 完全关闭召回,退回纯索引 + Read 兜底。实现:`hooks.ts` `initManager` 内 `if (process.env.LICODE_MEMORY_RECALL !== "off") tools.register(createMemoryFetchTool(...))`。
- **memory-guide 引导**:`memory-guide.md:62` 现为"需要正文时用 Read 读取对应文件"。`memory-guide` 是静态层(`system-prompt.ts:26`),不受开关控制,故改用 **fallback 措辞**保证 on/off 自洽:
  > 需要某条记忆正文时,调用 `memory_fetch(slug)`(若该工具可用);召回关闭时用 Read 读 `.licode/memory/<type>/<slug>.md`。

---

## 4. 组件与改动

### 4.1 新增文件

| 文件 | 内容 |
|---|---|
| `packages/core/src/memory/loaded-memory-registry.ts` | `LoadedMemoryRegistry` 类 + `createLoadedMemoryRegistry` 工厂 |
| `packages/core/src/memory/loaded-memory-registry.test.ts` | registry 单元测试 |
| `packages/core/src/tools/builtin/memory-fetch.ts` | `memory_fetch` 工具 + `createMemoryFetchTool` 工厂 |
| `packages/core/src/tools/builtin/memory-fetch.test.ts` | 工具单元测试 |

### 4.2 改动文件(最小)

| 文件 | 改动 |
|---|---|
| `packages/core/src/memory/recall.ts` | `select` 签名加 `loaded` 参数 + prompt 改输出 `{add,prune}`;`pruneRecallMessages` -> `pruneIrrelevantRecallMessages`(选择性);`createMemoryRecallHandler` 接收 `registry`,新流程用 registry.getAll/add/remove |
| `packages/core/src/index.ts` | 导出 `createLoadedMemoryRegistry`、`createMemoryFetchTool` |
| `packages/cli/src/hooks.ts` | 创建 registry ref + initManager 里 rebuild + 条件 register memory_fetch;`createMemoryRecallHandler` 传 registry |
| `packages/core/src/conversation/templates/memory-guide.md` | 第 62 行改 fallback 措辞 |

### 4.3 不改动

`store.ts`、`loop.ts`、`buildRecallPair` 格式、`dream.ts`、提取 hook。

---

## 5. 数据流

### 5.1 一次主动召回(第二阶段)

1. 主模型在 system prompt 读到 MEMORY.md 索引(含 slug),结合完整上下文判断需要某条记忆正文。
2. 主模型发起 `tool_use: memory_fetch({ slugs: ["user/food-preferences", ...] })`。
3. `execute`:对每个 slug 查 `registry.has` -> 跳过已加载;未加载则 `store.load` + `store.recordUsage` + `registry.add(active)`;按 `## name (slug)\ncontent` 拼接返回。
4. 返回 tool_result 进对话历史,主模型下一轮 LLM 调用可见。**不被 prune 剪除**(name 不同)。

### 5.2 onTurnStart(第一阶段,改造后)

1. 刷新索引层。
2. `loaded = registry.getAll()`。
3. `select(query, store, loaded)` -> `{ add, prune }`。
4. 剪 `prune` 中的 side-query 合成对,`registry.remove`;active 不剪;`prune` 外的 side-query 保留(跨轮)。
5. 注入 `add`,`registry.add(sidequery)`。

---

## 6. 错误处理与降级

- **select 失败/超时(10s)**:降级为 `{ add: [], prune: [] }`--不剪不注入,已加载全保留。对话不受影响(与现行 `recall.ts:156-158` 返回空一致)。**反转默认的额外好处:select 失败时默认保留,安全**(不会因失败误剪)。
- **memory_fetch 单 slug 加载失败**:`store.load` 抛错 -> 该 slug 跳过,返回已成功部分 + 提示哪些失败。不阻断。
- **registry rebuild 失败(session 恢复)**:catch,registry 空 -> 退回"无已加载视图",select 不去重(可能重复注入,等同现行行为,无害)。
- **recordUsage 失败**:best-effort catch 忽略(与 `recall.ts:282` 一致)。

---

## 7. 测试策略

### 7.1 `memory-fetch.test.ts`
- 基本加载:slugs -> 返回正文,格式 `## name (slug)\ncontent`。
- 去重:`registry.has` 的 slug 跳过,返回"已在上下文"。
- 多 slug:部分已加载部分新,只返回新的。
- recordUsage:加载后 `registry.add(active)` + recordUsage 调用。
- slug 不存在:`load` null 跳过,返回提示。
- 失败:`load` 抛错不阻断。

### 7.2 `recall.test.ts`(扩展)
- select 新签名:传 `loaded`,输出 `{add, prune}`。
- prune 选择性:`prune[]` 剪其余保留;active 不剪。
- **漏输出安全**:select 不把某条已加载放进 `prune` -> 保留不剪(验证隐患消除)。
- select 超时降级:`{add:[],prune:[]}`。

### 7.3 `loaded-memory-registry.test.ts`
- rebuild 从消息重建(含 sidequery 合成对 + memory_fetch tool_result)。
- add/remove/has/getAll O(1) 行为。
- source 覆盖(同 slug 重新 add 覆盖旧 source)。

### 7.4 集成测试
- onTurnStart 全流程:刷新索引 -> registry.getAll -> select -> prune -> 注入 -> registry 同步。
- 双向去重:memory_fetch 召回的,下一轮 side-query 不重复注入;side-query 注入的,memory_fetch 不重复加载。

---

## 8. 验收标准

1. 主模型能调 `memory_fetch` 取正文,格式对齐 side-query(`## name (slug)\ncontent`)。
2. **双向去重**:side-query 不重复注入 memory_fetch 已召回的;memory_fetch 不重复加载 side-query 已注入的。
3. 主动召回不剪除(prune 只动 sidequery)。
4. 相关 side-query 跨轮保留(∉ prune);无关的(∈ prune)剪除。
5. select 漏输出不误剪(反转默认)。
6. select 失败/超时降级:不剪不注入,对话不受影响。
7. `LICODE_MEMORY_RECALL=off` 时 memory_fetch 不注册(与 side-query 共用开关)。
8. 现有测试全过,build 零错。

---

## 9. 风险与权衡

### 9.1 select prompt 复杂度上升
select 从"选 0-5 条新的"变成"输出 `{add, prune}` 双字段",prompt 更复杂。`deepseek-chat` 小模型输出稳定性有风险。缓解:prompt 明确字段格式 + 示例 + `parseResponse` 容错(解析失败降级 `{add:[],prune:[]}`)。

### 9.2 token 累积
相关 side-query 记忆跨轮保留 + 主动召回永不剪 -> 上下文记忆 token 单调增长(有界于"相关集合",但比现行"每轮全剪"多)。这是 A 方案为"跨轮保留"付出的代价。若未来成为问题,可加"已加载 side-query 保留数上限"或依赖 dream 归档自然收敛。

### 9.3 registry 状态一致性
registry 是会话级可变状态,add/remove 同步点需正确(见 §3.6)。漏同步会导致去重失效(重复注入,无害)或误保留(多留,无害)。最坏情况退回现行行为,不破坏对话。

### 9.4 与 retrieval-metadata 设计的关系
[retrieval-metadata 设计](2026-08-04-memory-retrieval-metadata-design.md)治"写入侧索引质量"(type/description/keywords),本设计治"召回机制"(被动+主动+双向去重)。两者正交互补:更准的索引提升两阶段召回的输入质量,但不改变本设计的机制。

---

## 10. 未尽事宜(留待实现计划)

- `parseResponse` 如何解析 `{add, prune}` JSON(容错策略)。
- select prompt 的完整措辞与示例。
- registry rebuild 的消息扫描实现(配对 tool_use/tool_result 的边界情况)。
- `pruneIrrelevantRecallMessages` 对"跨轮保留多对合成消息"的剪除实现(现行 `pruneRecallMessages` 假设至多一对)。
