# Phase 2 实现计划:预算感知消息构建 + 结构感知压缩(合并 Phase 2+3)

> **状态**:计划冻结,待 TDD 实现
>
> **冻结日期**:2026-07-30(基于 worktree `context-management-improvement` commit `bf1c55f` 的代码快照)
>
> **上位文档**:[context-improvement-plan.md](./context-improvement-plan.md) Phase 2 + Phase 3
>
> **说明**:经 brainstorming 决议,将蓝图的 Phase 2(激活预算感知消息构建)与 Phase 3(接活压缩替换硬停)合并为一个阶段。Phase 1(校准式 token 计数,commit `6db519e`+`17fa85d`)已完成并作为地基。本文沿用 Phase 1 计划的"冻结事实 / 目标 / 边界 / 设计决策 / TDD 步骤 / 验收 / 风险"格式与"独立可验证、可回退"原则。

---

## 一、冻结事实(本 Phase 相关)

以下事实已用 `file:line` 核实,作为实现基线。

### 1.1 Phase 1 已落地的计数地基

1. **`TokenCounter`**(`llm/token-counter.ts:12`):char-class 估算 + 内嵌 `TokenCalibrator`;`ratio` getter(`:16`)、`observe(base,real)`(`:24`)委托校准器;`estimateMessages`(`:55`)忠实按 block 文本估算(非 `JSON.stringify`)。
2. **`TokenCalibrator`**(`llm/token-calibrator.ts`):EMA ratio(首次 `real/base`,后续 `0.7·ratio+0.3·(real/base)`),clamp `[0.5, 4]`。
3. **`ConversationManager`**:`getTokenCount()`(`manager.ts:287`)= `round(estimateMessages(messages) × ratio)`;`getMessageTokenBase()`(`:298`)= `estimateMessages(messages)`(**仅消息,不含 system/tools**);`observeUsage(base, real)`(`:307`)。
4. **`AgentLoop.run()`**(`loop.ts:50`):每轮 `requestBase = getMessageTokenBase()`(`:76`)-> `collectResponse` -> `observeUsage(requestBase, response.usage.input)`(`:88`)。状态栏经 `createEventBus` 在 `agent-loop-complete` 调 `setTokenCount(getTokenCount())`(`hooks.ts:184`)。

### 1.2 休眠的预算/压缩脚手架(本 Phase 接活对象)

5. **`SystemPrompt.assemble(budget)`**(`system-prompt.ts:81`):always 层(`role` p0、`safety` p1)必发;可选层(`memory-guide` p4、`tool-use` p10)按 priority 填入,预算不足 `truncateToTokens` 截断。内部用 fresh `TokenCounter`(ratio=1,**raw 单位**,`:61`)。
6. **`buildMessages(tokenBudget?)`**(`manager.ts:121`):传 `tokenBudget ?? Infinity`。调用点:`loop.ts:67`(运行时)、`events/generator.ts:16`(仅 export,grep 确认非运行时路径)。均无参 -> `Infinity` -> 裁剪永不触发。
7. **`ContextCompressor.compress()`**(`compressor.ts:21`):死代码,**两处结构缺陷**:
   - (a) 按下标从尾保留到 `maxTokens/2`(`:29-36`),切点可能落在 `ToolUseMessage` 与其 `ToolResultMessage` 之间 -> 孤立 `tool_result` -> Anthropic API 报错;
   - (b) `replaceMessages([summaryMessage, ...keep])`(`:46`)把摘要 `assistant` 消息放第一条 -> 数组以 `assistant` 开头 -> API 报错(首条必须 `user`)。
8. **`trimToBudget()`**(`manager.ts:138`):死代码,同款结构缺陷(只认 user/assistant 文本对,忽略 tool 对)。
9. **`Summarizer.summarize()`**(`summarizer.ts:10`):死代码,content 用 `JSON.stringify`(`:16`)粗估。
10. **`contextMiddleware`**(`middleware.ts:5`):死代码,仅在 `user-message` 触发(每轮一次,非每步)。
11. **`context-compressed` 事件**(`events/types.ts:13`):类型就绪(`method: "trim" | "summarize"`、`removedMessages`),无生产者/消费者。
12. **`context/` 模块全死**:`index.ts:101-105` 仅 export,grep 确认无运行时引用。

### 1.3 接口与配置现状

13. **`LLMProvider.maxContextTokens`**(`provider.ts:95`);`AnthropicProvider = 200_000`(`anthropic.ts:16`)。
14. **`extractSystem()`**(`anthropic.ts:192`)把 `role: system` 抽到顶层 `system` 参数;`toAnthropicMessages()`(`:199`)过滤 system,只留 user/assistant。-> **SUMMARY 不能用 `system` 角色**(会被提到顶层、与系统提示混合、顺序丢失)。
15. **`TerminationPolicy.check()`**(`termination.ts:37`):`maxTokens = 200_000`(`:14`),超限抛 `TerminationError` 硬停;`AgentLoop` 每步循环顶调(`loop.ts:65`)。
16. **`collectResponse` 输出上限** `maxTokens: 4096`(`react.ts:36`)。
17. **memory recall**:`pruneRecallMessages`(`recall.ts:25`)每轮 `onTurnStart` 清旧 recall 对;`buildRecallPair`(`:56`)注入 `assistant tool_use(memory_recall)` + `user tool_result` 合成对,挂在当前 user 之后。recall 对是 tool 对形状,压缩须**原子处理**。
18. **`CommandContext.conversation`**(`registry.ts:12`)是窄接口(id/metadata/clear/getTokenCount/getMessageCount);CLI 直接传 `manager`(`hooks.ts:359/394/451`,结构式匹配)。`/context`(`extensions/commands/builtin/context.ts:4`)现展示 Model/Tokens/Messages/Session/Memory。
19. **worktree 无 node_modules**,实现前需 `pnpm install`;`dist/` 已 gitignore,无需提交构建产物。

### 1.4 Phase 1 遗留 caveat(本 Phase 修复)

20. **clamp-4 欠估**:Phase 1 的 `ratio = real_input / messages_base`,把 system+tools 吸收成乘数。system+tools > 3× messages 时 ratio 撞上限 4 -> `getTokenCount()` 欠估 -> 压缩触发偏晚。Phase 1 计划已注明"Phase 2 把 system/tools 纳入显式预算后可消除"。**本 Phase 升级校准模型修复**(见决策 D6)。

---

## 二、目标

- **G1 预算管线就位**:`contextWindow`(来自 provider)+ `outputReserve` 配置;`buildMessages` 传入真实 `systemBudget`;`assemble` 压力下按 priority 裁剪可选层、always 层必发、system prompt 永不超分配预算。
- **G2 校准升级**:`getMessageTokenBase()` 含 system + tools;`ratio` 退化为 ≈1 的估算修正系数;`getTokenCount()` 跨大小可信(消除 clamp-4 欠估)。
- **G3 结构感知压缩替换硬停**:长会话接近阈值自动压缩续命,不再直接 `TerminationError`;按**轮次边界**切分,tool 对/recall 对原子、首条 user 保留、SUMMARY=`assistant` 放首条 user 之后、角色交替合法、无孤立 `tool_result`。
- **G4 硬停降级**:`maxTokens` 从"一超即死"变为"压缩后仍超的最终兜底"。
- **G5 事件 + UI**:发 `context-compressed` 且状态栏可见("已压缩 N 条");`/context` 展示窗口配置与剩余预算。
- **G6 零回归**:短会话零压缩、零行为变化;零新依赖;接口同步(`buildMessages`/`termination.check` 签名不变,无 async 波及)。

---

## 三、问题边界(范围)

**本 Phase 做**:
- 新增 `ContextConfig`(`outputReserve`/`compressThreshold`/`keepRecentTurns`/`summarizerModel`)。
- 校准升级:`getMessageTokenBase()` 含 system + tools;`getTokenCount()` 用全 base。
- `systemBudget` 计算 + `buildMessages` 传真实 budget + 激活 `assemble` 裁剪。
- 重写 `ContextCompressor`:结构感知、轮次切、SUMMARY=`assistant`、summarizer 走 side provider。
- `AgentLoop` 接入压缩 + 硬停降级;发 `context-compressed`。
- `createEventBus` 消费 `context-compressed` -> 状态栏;`/context` 展示窗口/剩余。
- 废弃旧 `compress()`/`trimToBudget()`/旧 `Summarizer`/`contextMiddleware` 死码(改造或删除并更新 export)。

**本 Phase 不做(显式排除)**:
- ❌ 滚动演化摘要(每次压缩把新裁轮次并入已有 SUMMARY)--留 Phase 5;本 Phase 做 one-shot。
- ❌ 工具输出溢出保护 `overflowToolResult`(read/bash/grep 落盘指针)--留 Phase 4。
- ❌ 真 tokenizer(tiktoken/gpt-tokenizer)/`messages.countTokens` API--保持校准式,零新依赖。
- ❌ prompt caching 的 cache token 汇总--当前未启用 caching。
- ❌ 改 `events/generator.ts` 运行时行为--legacy export,仅同步 `buildMessages` 的 budget 参数保持一致。
- ❌ `selective retention`(标记重要轮次不压缩)--留 Phase 5。

---

## 四、设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| D1 窗口来源 | `provider.maxContextTokens` | 单一来源;不同模型窗口不同;AgentLoop 已持有 `llm` |
| D2 `outputReserve` | 8192(config 可调) | 输出上限 4096 + 缓冲 |
| D3 `compressThreshold` | 0.85 | 留 15% 余量让压缩有空间跑、不至于撞硬停 |
| D4 `keepRecentTurns` | 2 | 保留近期细节 vs 压缩力度的折中 |
| D5 `summarizerModel` | `deepseek-chat`(side `AnthropicProvider`) | 便宜快,仿 `MemoryRecall` 的 side-query |
| D6 **校准模型** | **升级**:`base = messages + system + tools` | `ratio` 退化为 ≈1 的估算修正,消除 clamp-4 欠估;运行时零额外开销(纯本地估算,system 估算 `assemble` 本就在算);仅一次性测试 churn |
| D7 `systemBudget` 单位 | raw(ratio=1) | 与 `assemble` 内部 fresh `TokenCounter` 一致 |
| D8 压缩触发判定 | calibrated `getTokenCount() > threshold × window` | 对齐真实后端用量;与 200k 闸门同源 |
| D9 system/tools 注入 manager | loop 经 setter 喂入(`setToolTokenBase`/`setContextWindow`) | manager 是 `getTokenCount`/预算展示的单一来源;manager 本身不知 tools/provider;`/context` 只能拿 manager |
| D10 SUMMARY 角色 | `assistant`,放首条 `UserMessage` 之后 | 角色交替天然成立;不孤立 `tool_result`;语义准确(模型承接自己的历史);`system` 角色会被 `extractSystem` 提到顶层不可用 |
| D11 切分方式 | 轮次边界(每个 `UserMessage` 之前下刀) | tool 对/recall 对总在轮次内部,不切断;切点天然合法 |
| D12 摘要演化 | one-shot(每次从现存历史重摘一段) | 滚动演化留 Phase 5 |
| D13 摘要失败 | 降级为丢弃旧轮次(`method: "trim"`) | best-effort,永不中断主循环 |
| D14 硬停 | 压缩后仍 `> maxTokens` 才触发 | 从"一超即死"降级为最终兜底 |
| D15 旧 `compress`/`trimToBudget` | 原位重写 `compressor.ts`(保留 `ContextCompressor` 类名,替换实现+测试);删除 `middleware.ts`+`middleware.test.ts`(触发模型 user-message 不适用);`summarizer.ts` 内联进压缩器或留作薄封装(改 `JSON.stringify` 为内容文本);移除 `ConversationManager.trimToBudget()` 方法及其测试 | 取舍两套重叠机制;新压缩器同时满足"保留结构 + 摘要续命";`TokenBudget`/`overflowToolResult` 仍是死码,本 Phase 不动(Phase 4 处理 overflow) |
| D16 触发点 | `AgentLoop.run()` while 循环内、每步 LLM 前 | 能在工具轮次中实时响应增长;`contextMiddleware` 的"每轮一次"不够 |

### 4.1 关键数据流(每步 LLM 调用前)

```
run() while 循环顺序(新):
  1. (压缩检查) if getTokenCount() > compressThreshold × contextWindow:
       compressor.compress()  ->  replaceMessages([首条U, SUMMARY, ...保留轮次])
       emit context-compressed
  2. termination.check(getTokenCount())   // 降级兜底:压缩后仍超才硬停
  3. systemBudget = contextWindow - outputReserve - rawMessages - rawTools
  4. messages = buildMessages(systemBudget)   // assemble 压力下裁可选层
  5. requestBase = getMessageTokenBase()      // 升级后 = messages+system+tools(raw)
  6. collectResponse -> observeUsage(requestBase, usage.input)
```

### 4.2 压缩后的消息形状

```
压缩前:
U1(任务)  A1  [aT1][uR1]  A2  [aT2][uR2]  U2(当前轮)  [aT3][uR3](进行中)
                       ↑ 切点(轮次边界:UserMessage 之前)

压缩后:
U1(user)  SUMMARY(assistant)  [aT2][uR2]  U2(user)  [aT3][uR3]
          ↑ 旧轮次摘要          ↑ 最近 keepRecentTurns 轮 + 当前轮,原子保留

角色交替: U(user)->SUMMARY(assistant)->[aT2](assistant)... 
          因保留窗口从 UserMessage 起,每轮 user 开头,交替天然成立。
```

---

## 五、实现步骤(TDD 循环)

严格遵循红-绿-重构。每个循环:写失败测试 -> 看它失败 -> 最少代码 -> 看它通过 -> 重构。

```
=== A. 校准升级(地基) ===
Cycle 1  ConversationManager.setToolTokenBase:设值后 getMessageTokenBase 增大(红)
Cycle 2  getMessageTokenBase 含 system prompt:加 system 层后 base 增大(红)
Cycle 3  getTokenCount 用全 base:观测后 ratio≈1(旧 message-only base 会 >1,红)
Cycle 4  AgentLoop 喂 tool base + 设 contextWindow:requestBase 为全 base(假 provider,红)
Cycle 5  修 Phase 1 受影响测试(manager/loop base 断言)+ pnpm test 绿

=== B. 预算管线 + assemble 激活 ===
Cycle 6  ContextConfig + AgentConfig.context(默认值注入)
Cycle 7  AgentLoop 算 systemBudget 传 buildMessages:小 budget 下 assemble 丢可选层、留 always(红)
Cycle 8  短会话全层发送、零裁剪(回归)

=== C. 结构感知压缩器(重写 ContextCompressor)===
Cycle 9  splitIntoTurns:tool 对不跨轮次;recall 对在轮次内(红)
Cycle 10 compress 保留首条 U + 最近 N 轮 + 当前;SUMMARY=assistant 放首条 U 后;
         无孤立 tool_result、角色交替合法(假 summarizer,红)
Cycle 11 当前轮含 recall 对:原子保留、不被摘要(红)
Cycle 12 summarizer 失败 -> 降级 trim(丢旧轮次、无 SUMMARY、method:"trim")(红)
Cycle 13 未超阈值 -> compressed:false、不改 messages(回归)

=== D. AgentLoop 集成 ===
Cycle 14 超阈值触发压缩 + 发 context-compressed;压缩后 termination.check 用缩减值;
         仍超 maxTokens 才硬停(红)
Cycle 15 短会话不压缩、不发声(回归)

=== E. UI + /context ===
Cycle 16 ConversationManager.getBudgetInfo + CommandContext.conversation 声明该方法;
         /context 展示 window/reserve/used/remaining(红)
Cycle 17 createEventBus 消费 context-compressed -> setCommandMessage("已压缩 N 条")(红)

=== F. 收尾 ===
Cycle 18 全量 pnpm test + pnpm build,零回归;原位重写 compressor.ts、删 middleware.ts、内联/薄封装 summarizer.ts、移除 trimToBudget 方法及各自测试、清 index.ts export
```

---

## 六、验收结论

实现完成的判定标准(全部需勾选):

- [ ] `systemBudget` 压力下可选系统层按 priority 丢弃,always 层保留,system prompt 不超预算(Cycle 7 绿)
- [ ] 校准升级:`getMessageTokenBase()` 含 system+tools;观测后 ratio≈1;`getTokenCount()` 跨大小可信(Cycle 1-4 绿)
- [ ] 长会话接近阈值自动压缩续命,不再直接 `TerminationError`(Cycle 14 绿)
- [ ] 压缩后无孤立 `tool_result`(API 不报错);首条 user + 最近轮次保留;角色交替合法(Cycle 10 绿)
- [ ] recall 对原子保留(Cycle 11 绿)
- [ ] summarizer 失败降级 trim、不崩(Cycle 12 绿)
- [ ] 硬停降级为压缩后兜底(Cycle 14 绿)
- [ ] `context-compressed` 事件正确发出且状态栏可见(Cycle 17 绿)
- [ ] `/context` 展示窗口配置与剩余预算(Cycle 16 绿)
- [ ] 短会话零压缩、零行为回归(Cycle 8/13/15 绿)
- [ ] 旧 `compress()`/`trimToBudget()`/`Summarizer`/`contextMiddleware` 废弃,无运行时引用(Cycle 18)
- [ ] `pnpm test` 全绿(含 Phase 1 token-counter/manager/loop 测试),零回归
- [ ] `pnpm build` 零 TypeScript 错误
- [ ] 无新运行时依赖
- [ ] 接口同步:`buildMessages`/`TerminationPolicy.check` 签名不变,无 async 波及

**精度验收(运行时经验指标,不以单测硬断言)**:升级后 `getTokenCount()` 与 API 返回 `usage.input_tokens` 相对误差 ≤ ±5%(含 system+tools;cold-start 首轮除外)。方向性验收,实现后用真实会话抽样核对。

---

## 七、风险与 caveat

- **校准升级测试 churn**:`getMessageTokenBase()` 语义变化,Phase 1 的 manager/loop base 断言需更新(Cycle 5)。已识别受影响点:`manager.test.ts` 的 base 断言、`loop.test.ts` Cycle 11 的 requestBase。
- **摘要 LLM 延迟/成本**:仅阈值触发(非每步);side 模型 `deepseek-chat` 省钱;不阻塞主循环(失败降级 trim)。
- **side 模型摘要质量**:离线人工抽检,不阻塞主循环;质量不足时后续可换模型(config 已留口)。
- **接缝角色交替**:按轮次切(切点在 `UserMessage` 之前)已从结构上规避;边界用 Cycle 10 测试锁定。
- **cold-start**:首轮 ratio=1;升级后 base 已含 system+tools,欠估幅度较 Phase 1 大幅缓解,compressThreshold 0.85 余量兜底。
- **system 估算口径**:`getMessageTokenBase()` 的 system 部分按 `assemble(Infinity)` 全量估算(非实际裁剪后),以保证 `termination.check` 在 `buildMessages` 之前调用时也有值。压力下 assemble 实际裁剪了 system -> 该轮 base 略偏大 -> ratio 略 <1;仅阈值附近出现、EMA 平滑、偏保守(倾向更早压缩),影响可忽略。若需精确,后续可让 `buildMessages` 缓存实际装配的 system 估算供下轮使用。
- **prompt caching caveat**:同 Phase 1,未启用 caching;若未来启用,需 provider 汇总 `cache_creation/cache_read_input_tokens` 入 `input`。
- **one-shot 摘要信息丢失**:跨多次压缩累积丢细节;Phase 5 滚动演化摘要解决。
- **`events/generator.ts`**:legacy export,仅同步 `buildMessages` budget 参数,不改运行时行为。
- **`outputReserve` 与 `maxTokens` 关系**:`outputReserve=8192` > 输出上限 4096,留缓冲;若后续调 `react.ts` 的 `maxTokens`,需同步审视。
