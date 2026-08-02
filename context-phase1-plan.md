# Phase 1 实现计划:校准式 token 计数

> **状态**:计划冻结,待 TDD 实现
>
> **冻结日期**:2026-07-29(基于 commit `192932c` + worktree `1acb44c` 的代码快照)
>
> **上位文档**:[context-improvement-plan.md](./context-improvement-plan.md) Phase 1

---

## 一、冻结事实(Phase 1 相关)

以下事实已在调研中用 `file:line` 核实,作为实现基线:

1. **`TokenCounter` 接口**(`llm/token-counter.ts:10`):`estimate(text: string): number` 与 `estimateMessages(messages: Message[]): number`,均同步。6 个调用点:`system-prompt.ts`、`manager.ts`、`compressor.ts`、`token-budget.ts`、`anthropic.ts:148`(`countTokens` 委托)。**接口必须保持不变**。
2. **当前估算为 2 类字符比例启发式**(`token-counter.ts:11`):CJK 1.5 字符/token、其他 4 字符/token;非字符串 content 用 `JSON.stringify` 粗估。
3. **`LLMProvider` 接口**(`provider.ts:93`):已有 `countTokens(messages): number`(同步)与 `maxContextTokens`。`AnthropicProvider.maxContextTokens = 200_000`。
4. **真实 usage 已可得**:`AnthropicProvider.stream` 的 `stop` chunk 返回 `usage: { input, output }`(`anthropic.ts:127`);`collectResponse` 在 text 与 tool-use 两个分支都返回 `usage`(`react.ts`);`AgentLoop` 拿到 `response.usage`。
5. **SDK 0.50.4** 有 stable `client.messages.countTokens()`(async,精确,但仅 Anthropic 后端、有网络往返)。
6. **后端可能非 Anthropic**:`cli.ts:229` 明确支持 `ANTHROPIC_BASE_URL` 接 DeepSeek 等。Anthropic 不公开其 tokenizer,DeepSeek 又是另一套分词--**任何本地 BPE 库对实际后端都只是近似**。
7. **未启用 prompt caching**:`cache_control` 仅 `anthropic.ts:175` 透传管道,无调用方,系统提示模板无缓存标记。故 `usage.input_tokens` 即完整输入 token 数。
8. **`ConversationManager.getTokenCount()`**(`manager.ts:287`)当前 = `estimateMessages(this.messages)`,只数消息(不含 system prompt、不含 tools)。
9. **`TerminationPolicy.check`**(`termination.ts:37`)用 `getTokenCount()` 对比 `maxTokens=200_000`,同步,在 `AgentLoop` 每步循环顶部调用(`loop.ts:65`)。
10. **worktree 无 node_modules**,实现前需 `pnpm install`。

## 二、目标

用"改进的基底估算 + 在线校准"替代粗略启发式,使 token 预测可信,为 Phase 2/3 的预算裁剪与压缩提供地基:

- **G1**:`estimate` 由 2 类升级为 char-class(CJK / 字母数字 / 标点符号 / 空白),代码与 JSON 的小 token 密度被合理反映。
- **G2**:`estimateMessages` 忠实处理 `Message` union:tool 消息按内容文本估算,而非 `JSON.stringify`。
- **G3**:引入校准器,用每轮真实 `usage.input_tokens` 在线学习修正系数(EMA),把 system prompt + tools + 结构开销吸收为乘数,使 `getTokenCount()` ≈ 完整请求大小。
- **G4**:`TokenCounter` 接口不变(同步),`LLMProvider.countTokens` 与 `TerminationPolicy.check` 签名不变,无 async 波及。
- **G5**:后端无关(Anthropic / DeepSeek 通用),零新依赖。

## 三、问题边界(范围)

**本 Phase 做**:
- 改写 `TokenCounter`(char-class + 忠实 `estimateMessages` + 内嵌校准器)。
- `ConversationManager` 增 `getMessageTokenBase()` / `observeUsage(base, real)`,`getTokenCount()` 应用校准。
- `AgentLoop` 接入真实 usage 观测。

**本 Phase 不做(显式排除)**:
- ❌ 不接 `messages.countTokens()` API(留作后续可选增强;其 async 会波及同步调用点)。
- ❌ 不引入 tiktoken / gpt-tokenizer 依赖(对实际后端仅近似,且与"零新依赖"冲突)。
- ❌ 不改 `SystemPrompt.assemble` 的预算来源(Phase 2 激活)。
- ❌ 不接活压缩 / 不改终止策略的硬停行为(Phase 3)。
- ❌ 不处理 prompt caching 的 cache token 汇总(当前未启用 caching;记为 caveat)。
- ❌ 不改 `ContextCompressor` / `trimToBudget` / `overflowToolResult`(死代码,后续 Phase 处理)。

## 四、设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 计数方案 | 校准式启发式 | 本地 BPE 对 Claude/DeepSeek 仅近似;真值来自后端 usage;零依赖;后端无关 |
| 校准目标 | `ratio = real / base`,base = 消息 token(不含 system/tools) | ratio 吸收 system+tools+结构开销为乘数,`getTokenCount`≈完整请求,正好对接 200k 窗口 |
| 校准算法 | EMA(`first: ratio=real/base; then: ratio=0.7*ratio+0.3*(real/base)`),clamp `[0.5, 4]` | 在线、抗抖动;clamp 防单次异常(如缓存/空响应) |
| 观测时机 | `AgentLoop` 在 `collectResponse` 前捕获 base、响应后 `observeUsage(base, usage.input)` | base 必须是输入消息(响应未追加前);usage 在两分支都有 |
| 接口 | 保持 `estimate`/`estimateMessages` 同步 | 6 个调用点零波及;TerminationPolicy 不改 |
| 共享校准状态 | 校准器挂在 `ConversationManager` 的 `TokenCounter` 上;`AnthropicProvider`/`SystemPrompt` 各自 counter 保持纯基底 | 校准只对预算闸门有意义;其余场景做相对比较不需校准 |

## 五、实现步骤(TDD 循环)

严格遵循红-绿-重构。每个循环:写失败测试 → 看它失败 → 最少代码 → 看它通过 → 重构。

```
Cycle 1  TokenCalibrator 冷启动:无观测时 ratio === 1
Cycle 2  TokenCalibrator 首次观测:ratio === real/base
Cycle 3  TokenCalibrator 后续观测:EMA 更新(可计算确定值)
Cycle 4  TokenCalibrator clamp:ratio 限制在 [0.5, 4]
Cycle 5  TokenCounter.observe / ratio:委托内部 calibrator
Cycle 6  TokenCounter.estimate char-class:符号串 token 密度 > 同长度字母串(当前 2 类不区分,红)
Cycle 7  TokenCounter.estimateMessages 忠实:tool_result 同内容不同 ID 估算相等(当前 JSON.stringify,红)
Cycle 8  ConversationManager.getMessageTokenBase:返回原始基底(无 ratio)
Cycle 9  ConversationManager.observeUsage(base, real):喂校准器
Cycle 10 ConversationManager.getTokenCount 校准:观测后返回 base*ratio(当前无 ratio,红)
Cycle 11 AgentLoop 接线:run 后 getTokenCount 反映校准(用假 provider 返回 usage,红)
Cycle 12 全量 pnpm test + pnpm build:零回归
Cycle 13 状态栏显示(收尾):createEventBus 在 agent-loop-complete 调 setTokenCount(getTokenCount());移除死掉的 tokenCountingMiddleware(红)
```

## 六、验收结论

实现完成的判定标准(全部需勾选):

- [ ] char-class:符号串估算 > 同长度字母串(Cycle 6 绿)
- [ ] tool 消息按内容估算,与 ID 无关(Cycle 7 绿)
- [ ] 校准器冷启动 ratio=1;首次=real/base;EMA 与 clamp 行为正确(Cycle 1-4 绿)
- [ ] `ConversationManager.getTokenCount()` 在观测后应用 ratio;未观测时等价现状(Cycle 10 绿)
- [ ] `AgentLoop` 每轮把真实 `usage.input` 喂入校准器(Cycle 11 绿)
- [ ] 状态栏显示校准后的 token 数(非 0);`/context` 与状态栏语义一致(Cycle 13 绿)
- [ ] `TokenCounter` 接口签名不变,6 个调用点零改动
- [ ] `pnpm test` 全绿(含原有 token-counter / manager / loop 测试),零回归
- [ ] `pnpm build` 零 TypeScript 错误
- [ ] 无新运行时依赖

**精度验收(有校准样本后)**:对真实会话,`getTokenCount()` 与 API 返回 `usage.input_tokens` 的相对误差目标 ≤ ±5%(cold-start 首轮除外)。此条为运行时经验指标,不以单测硬断言,但在计划中作为方向性验收。

## 收尾补记:状态栏显示缺口(原计划外)

实现中发现:`tokens: 0` 是**预存的显示断链**,非 Phase 1 造成,但原 5 阶段蓝图与 Phase 1 计划均未覆盖。根因:agent-loop 路径把事件发到 eventBus(非 pipeline),`tokenCountingMiddleware` 监听的 `llm-response-complete` 只存在于旧的 `generateChatEvents` 路径,故永不触发,`setTokenCount` 从不被调用。

作为 Phase 1 收尾(Cycle 13)修复:导出 `createEventBus`,在 `agent-loop-complete` 分支调 `setTokenCount(getTokenCount())`(每轮必发、带 usage),并移除死掉的 `tokenCountingMiddleware`。状态栏改为显示校准后的上下文大小,与 `/context` 命令语义一致。TDD:对 `createEventBus` 写失败测试(emit agent-loop-complete -> setTokenCount 收到 getTokenCount 值)再实现。

## 七、风险与 caveat

- **估算器数值变化**:极小预算下的 `trimToBudget` 测试可能受影响。已核查其断言为相对型(末轮保留、大预算全保留、空不抛),风险低;跑测后按需微调。
- **cold-start**:首轮 ratio=1,等价现状(只数消息,欠估 system+tools)。Phase 3 压缩兜底覆盖边界。
- **ratio 上限 4**:若 system prompt + tools 极大(>4× 消息),校准后仍欠估。Phase 2 把 system/tools 纳入显式预算后可消除。
- **prompt caching caveat**:若未来启用 caching,`usage.input_tokens` 不含缓存 token,需 provider 汇总 `cache_creation/cache_read_input_tokens` 入 `input`。本 Phase 不做。
