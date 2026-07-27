# 记忆系统 Phase 1（生产层修复）实现计划

> **日期**：2026-07-27
> **状态**：已批准，待实施
> **设计规格**：[2026-07-27-memory-system-redesign-design.md](./2026-07-27-memory-system-redesign-design.md)（本计划实现其 Phase 1；Phase 2-4 不在本次范围）
> **工作区**：worktree 分支 `worktree-memory-system-redesign`

---

## Context

用户痛点：记忆没有动态更新能力（先说"喜欢红烧排骨"后说"不喜欢"，系统不会改记忆文件）+ 越积越乱 + 希望对齐 Claude Code/Codex 业界实践。根因：

1. 关键词门槛 `shouldExtract()` 漏检纠正/决策类消息（"我不喜欢"不含"我喜欢"）；
2. LLM 输出的 `update` action 被 `extractor.ts` 忽略，`store.save()` 永远 naive append，矛盾并存；
3. 主 Agent 对记忆系统零感知（system prompt 无记忆指引），无法直接写记忆。

## 关键约束（调研已核实）

- 合成 `agent-loop-complete` 事件无时间戳 → 冷却计时用 hook 内 `Date.now()` + 共享状态对象
- `createMemoryExtractionHook` 注册时一次性创建闭包 → state 必须以**对象引用**传入（useRef `.current` identity 稳定）
- `SystemPrompt.addLayer` 按 name 去重，`MemoryLoader` 已注入 `"memory"` 层（priority 5）→ 新指引层命名 `"memory-guide"`，priority 4
- `store.save()` 有 3 处既有单参调用（middleware.ts、builtin/memory.ts×2）→ 第二参必须带默认值
- 仓库无任何现成 mtime/cooldown/mutex 工具 → 新实现

## 实施步骤（按依赖顺序）

### Step 0：环境（S）

`pnpm install`（worktree 无 node_modules）。

### Step 1：MemoryStore — action 语义 + rebuildIndex + hasChangesSince（M）

**文件**：`packages/core/src/memory/store.ts`

- 新增 `export type MemoryAction = "create" | "update" | "append"`
- `save(memory, action = "create")`：
  - `create`：不存在→新建；**已存在→防御降级为 append**（LLM 误标时不丢旧内容，兼容旧行为）
  - `update`：正文整体替换；保留现有 `createdAt`、刷新 `updatedAt` ← **红烧排骨核心修复**
  - `append`：段落级去重追加（新增模块级 helper `mergeAppend`，按 `\n\n+` 分段去重）
- 私有 `updateIndex()` → 公开 `rebuildIndex()`；索引行改相对路径 `- [name](${slug}.md) — desc`
- 新增 `hasChangesSince(tsMs)`：只扫 4 个 type 子目录的 .md（天然排除 MEMORY.md），任一 `stat.mtimeMs >= tsMs` → true

**测试** `packages/core/src/memory/memory.test.ts`：

- 同步改 2 处既有断言（L153、L208：索引绝对路径 → 相对路径）
- 新增 `describe("MemoryStore actions")`：update 替换/保留 createdAt、update 于不存在 slug、append 段落去重、create 降级 append、默认 save 兼容、rebuildIndex 覆盖直接 Write 的文件、坏 frontmatter 容错、hasChangesSince（用 `fs.utimesSync` 显式设 mtime，**禁止依赖"刚写入 mtime 一定 > now"**——同毫秒会相等）、索引相对路径

### Step 2：MemoryExtractor — 门槛重构 + prompt 升级（L）

**文件**：`packages/core/src/memory/extractor.ts`

- 删除 `TRIGGER_KEYWORDS_CN/EN` 白名单；保留 `isQuestionLike()`
- 新增 `EXPLICIT_INSTRUCTIONS = ["记住","记一下","不要忘记","别忘了","remember"]`
- 构造 config 加 `cooldownMs?`（默认 5 分钟）
- 新签名 `shouldExtract(messages, { lastExtractedAt, now? })`：空→false；无新用户消息（`Date.parse(timestamp) > lastExtractedAt`）→false；**新消息含明确指令→true（绕过冷却）**；全部新消息疑似问句→false；冷却内→false
- `extract(messages, store, { sinceMs?, maxMessages? })`：
  - prompt 带**全部现有记忆正文**（`store.listAll()` 格式化）+ 索引 —— LLM 必须看到旧正文才能 update
  - 消息选择：timestamp > sinceMs，`slice(-50)` 上限
  - `buildPrompt` 按规格 §3.3.2 重写（矛盾必须 update / feedback 含 Why+How to apply / 禁存清单 / 相对日期转绝对 / 只用最近对话）
  - `maxTokens: 1024 → 2048`
  - `parseResponse` 校验收紧：action/type 枚举、slug 以 `${type}/` 开头，非法单条丢弃
  - 落盘 `store.save(memory, item.action)` —— action 真正生效

**测试** `packages/core/src/memory/extractor-llm.test.ts`：

- `describe("shouldExtract")` 8 个旧用例**整组重写**（签名+语义变更）：无关键词纠正类→true、明确指令绕过冷却、纯问句→false、无新消息→false、冷却内→false、冷却外普通陈述→**true（语义反转）**、问句+陈述混合→true、旧消息含"记住"不绕过→false、空数组→false
- extract 保留既有 5 用例，新增：prompt 含现有记忆正文、**update 落盘替换（矛盾处理验收）**、maxTokens 2048、非法条目丢弃、sinceMs 过滤

### Step 3：Hook — 共享状态 + 互斥 + 主 Agent 已写跳过（M）

**文件**：`packages/core/src/memory/hook.ts`（整文件重写）

```ts
export interface MemoryExtractionState {
  lastExtractedAt: number; // ms epoch，0 = 从未提取
  loopStartedAt: number;   // ms epoch，0 = 未知（不检查主 Agent 写入）
  running: boolean;        // 进程内互斥
}
export function createMemoryExtractionState(): MemoryExtractionState;
```

hook 逻辑（对应规格 §3.2）：

1. 非 `agent-loop-complete` → return
2. `state.running` → return（互斥不排队）
3. `loopStartedAt > 0` 且 `store.hasChangesSince(loopStartedAt)` → `rebuildIndex()` + return（主 Agent 本轮已写；**不**更新 lastExtractedAt）
4. `shouldExtract(messages, { lastExtractedAt })` → false 则 return
5. `const sinceMs = state.lastExtractedAt; state.lastExtractedAt = Date.now()`（⚠️ 先捕获再更新；尝试即更新防失败风暴）
6. `running = true; try { extract(messages, store, { sinceMs }) } finally { running = false }`

**测试** `packages/core/src/memory/hook.test.ts`（4 旧用例整组重写）：正常路径、gate false 不调 extract、非目标事件、互斥跳过、主 Agent 已写→rebuildIndex+不调 shouldExtract、loopStartedAt=0 不检查、并发只跑一次、extract reject 后 running 复位

### Step 4：core 导出（S）

**文件**：`packages/core/src/index.ts`（L114-122 memory 块追加）

`createMemoryExtractionState`、`MemoryExtractionState`（from hook.js）、`MemoryAction`（from store.js）

### Step 5：主 Agent 记忆指引层（S，可与 1-4 并行）

- **新文件** `packages/core/src/conversation/templates/memory-guide.md`：内容 = 规格 §3.3.1 全文，唯一调整：`<cwd>/.licode/memory/` → "当前项目根目录下的 `.licode/memory/`"（模板静态无插值）
- **文件** `packages/core/src/conversation/system-prompt.ts`：`LAYER_DEFINITIONS` 在 safety 后插入 `{ name: "memory-guide", priority: 4, always: false, file: "memory-guide.md" }`
- 构建脚本 `cp -r templates` 整目录拷贝，**无需改**
- **测试** `system-prompt.test.ts` 加 1 例：tmpDir 写 memory-guide.md → 层含 name/priority/always

### Step 6：CLI 接线（S）

**文件**：`packages/cli/src/hooks.ts`

- import `createMemoryExtractionState` + 类型
- L209-214 附近新增 `const memoryExtractionStateRef = useRef(createMemoryExtractionState())`
- hook 注册（L267-277）第 4 参传 `memoryExtractionStateRef.current`
- `handleSubmit`（L314，guard 之后、路由之前）：`memoryExtractionStateRef.current.loopStartedAt = Date.now()`
- **不改** `packages/cli/src/cli.ts`（非 React 路径自动获得 memory-guide 层；提取维持现状）

### Step 7：构建 + 回归 + 验收（M）

```bash
npx vitest run packages/core/src/memory packages/core/src/conversation/system-prompt.test.ts
npm test          # 全量回归（根目录）
pnpm -r build     # tsc + 模板拷贝；CLI 生效前提！
ls packages/core/dist/conversation/templates/   # 必须含 memory-guide.md
```

## 风险与注意点

1. **dist 构建是 CLI 生效前提**：只改源码不 build，CLI 直接 import 报错/层静默缺失
2. **模板缺失静默跳过**：文件名拼错无报错，靠 dist 检查 + 测试防呆
3. **既有测试回归清单**（其余 memory 相关用例不变）：memory.test.ts 2 处断言、extractor-llm.test.ts shouldExtract 整组、hook.test.ts 整组
4. **跨轮提取写文件 mtime 可能落在下一轮 loopStartedAt 之后** → 误判"主 Agent 已写"一次，结果=rebuildIndex+跳过一轮，自愈可接受
5. **冷却放宽的代价**：普通闲聊也会过 gate（LLM 输出 []），5 分钟冷却封顶成本——规格的明确取舍
6. **loopStartedAt=0 守卫**：否则会话恢复场景旧记忆全部命中"已写"，永久跳过提取

## 验证（对应规格 §4 验收标准）

手工跑 `npm start` 逐条验收：

1. "我喜欢红烧排骨" → 再说"我其实不喜欢吃了" → 同文件正文被改写，无矛盾并存
2. "不对，我以后都用 pnpm 装依赖" → feedback 记忆含 Why/How to apply
3. "现在几点了？" → 无提取
4. 5 分钟内连续闲聊最多提取一次；"记住：我的编辑器是 Neovim" → 立即触发
5. 主 Agent 当轮写记忆 → 后台抽取跳过
6. 主 Agent 直接 Write 的文件 → 当轮后 MEMORY.md 含其索引行
7. 全部新旧测试通过

## 收尾

全部验收通过后：在 worktree 分支 commit（沿用项目 commit 风格）→ push → `gh pr create --draft`（含本分支已有的规格 commit）。
